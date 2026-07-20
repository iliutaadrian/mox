// Package mail fetches messages over IMAP and persists new ones to the local
// store. It is strictly read-only: it never sets flags, moves, or deletes
// anything on the server. Sync is UID-incremental — each run pulls only UIDs
// above the highest one already stored.
package mail

import (
	"bytes"
	"fmt"
	nethtml "html"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-message/mail"

	// Register extra charset decoders so non-UTF-8 mail parses.
	_ "github.com/emersion/go-message/charset"

	"github.com/iliutaadrian/spark-cli/internal/config"
	"github.com/iliutaadrian/spark-cli/internal/store"
)

// fetchChunk caps how many messages are pulled per FETCH command, so a large
// backfill arrives in steady batches (gentler on throttling servers like Yahoo).
const fetchChunk = 200

// dial opens a TLS connection, logs in and sends the IMAP ID. The caller is
// responsible for Close()/Logout(). Set SPARK_IMAP_DEBUG to dump the protocol.
func dial(acc config.Account) (*imapclient.Client, error) {
	addr := fmt.Sprintf("%s:%d", acc.IMAPHost, acc.IMAPPort)
	var dialOpts *imapclient.Options
	if os.Getenv("SPARK_IMAP_DEBUG") != "" {
		dialOpts = &imapclient.Options{DebugWriter: os.Stderr}
	}
	c, err := imapclient.DialTLS(addr, dialOpts)
	if err != nil {
		return nil, fmt.Errorf("%s: dial: %w", acc.Name, err)
	}
	if err := c.Login(acc.IMAPUser, acc.IMAPPass).Wait(); err != nil {
		c.Close()
		return nil, fmt.Errorf("%s: login: %w", acc.Name, err)
	}
	// Yahoo (and AOL) drop the connection on the next command unless the client
	// first identifies itself with an IMAP ID (RFC 2971). Best-effort.
	c.ID(&imap.IDData{Name: "spark-cli", Version: "1.0"}).Wait()
	return c, nil
}

// Sync pulls mail for one account into the store and returns how many new
// messages were inserted. New arrivals are always pulled (forward). For the
// rest it either:
//   - date-windowed (fetchSinceDays > 0): every message received within the
//     window, fetching only UIDs not already stored (resumable, no re-download), or
//   - count-based (otherwise): progressively older mail until the local count
//     reaches fetchLimit.
//
// Either way, raising the limit/window and re-running grows the corpus WITHOUT
// wiping the database. Strictly read-only: EXAMINE + BODY.PEEK, nothing on the
// server changes.
func Sync(st *store.Store, acc config.Account, fetchLimit, fetchSinceDays int) (int, error) {
	c, err := dial(acc)
	if err != nil {
		return 0, err
	}
	defer c.Close()
	defer func() { c.Logout().Wait() }()

	sel, err := c.Select(acc.Mailbox, &imap.SelectOptions{ReadOnly: true}).Wait()
	if err != nil {
		return 0, fmt.Errorf("%s: select %s: %w", acc.Name, acc.Mailbox, err)
	}

	storedValidity, lastUID, err := st.SyncState(acc.Name, acc.Mailbox)
	if err != nil {
		return 0, err
	}
	// If UIDVALIDITY changed, the server's UIDs are no longer comparable — reset.
	if storedValidity != 0 && storedValidity != sel.UIDValidity {
		if err := st.ResetMailbox(acc.Name, acc.Mailbox); err != nil {
			return 0, err
		}
		lastUID = 0
	}

	inserted := 0
	maxUID := lastUID

	// 1) Forward: new arrivals with UID above what we've already seen.
	if lastUID > 0 {
		set := imap.UIDSet{}
		set.AddRange(imap.UID(lastUID+1), 0) // 0 == "*"
		n, mx, err := fetchInsert(c, acc, st, set)
		if err != nil {
			return inserted, fmt.Errorf("%s: fetch (forward): %w", acc.Name, err)
		}
		inserted += n
		if mx > maxUID {
			maxUID = mx
		}
	}

	// 2) Fill the rest of the window/limit.
	if fetchSinceDays > 0 {
		// Date-windowed: fetch every message since the cutoff that we don't have.
		since := time.Now().AddDate(0, 0, -fetchSinceDays)
		data, err := c.UIDSearch(&imap.SearchCriteria{Since: since}, nil).Wait()
		if err != nil {
			return inserted, fmt.Errorf("%s: search since: %w", acc.Name, err)
		}
		stored, err := st.StoredUIDs(acc.Name, acc.Mailbox)
		if err != nil {
			return inserted, err
		}
		var missing []imap.UID
		for _, u := range data.AllUIDs() {
			if !stored[uint32(u)] {
				missing = append(missing, u)
			}
		}
		for i := 0; i < len(missing); i += fetchChunk {
			end := i + fetchChunk
			if end > len(missing) {
				end = len(missing)
			}
			set := imap.UIDSet{}
			for _, u := range missing[i:end] {
				set.AddNum(u)
			}
			n, mx, err := fetchInsert(c, acc, st, set)
			if err != nil {
				return inserted, fmt.Errorf("%s: fetch (window): %w", acc.Name, err)
			}
			inserted += n
			if mx > maxUID {
				maxUID = mx
			}
		}
	} else {
		// Count-based: pull older messages (by sequence) in chunks until we hold
		// the newest fetchLimit, or the mailbox is exhausted.
		for {
			have, err := st.CountMessages(acc.Name, acc.Mailbox)
			if err != nil {
				return inserted, err
			}
			if have >= fetchLimit || uint32(have) >= sel.NumMessages {
				break
			}
			topOlder := sel.NumMessages - uint32(have) // seq of newest not-yet-stored
			want := fetchLimit - have
			if want > fetchChunk {
				want = fetchChunk
			}
			start := uint32(1)
			if topOlder > uint32(want) {
				start = topOlder - uint32(want) + 1
			}
			set := imap.SeqSet{}
			set.AddRange(start, topOlder)
			n, mx, err := fetchInsert(c, acc, st, set)
			if err != nil {
				return inserted, fmt.Errorf("%s: fetch (backfill): %w", acc.Name, err)
			}
			inserted += n
			if mx > maxUID {
				maxUID = mx
			}
			if n == 0 {
				break // safety: nothing new came back, avoid an infinite loop
			}
		}
	}

	if err := st.SetSyncState(acc.Name, acc.Mailbox, sel.UIDValidity, maxUID); err != nil {
		return inserted, err
	}
	return inserted, nil
}

// FetchAttachment re-fetches one message by UID (read-only, BODY.PEEK) and
// returns the bytes of the attachment whose filename matches name. Attachment
// files are never stored locally — this pulls them on demand. If name is empty
// and the message has exactly one attachment, that one is returned. The second
// return is the matched filename (useful when name was empty).
func FetchAttachment(acc config.Account, uid uint32, name string) ([]byte, string, error) {
	c, err := dial(acc)
	if err != nil {
		return nil, "", err
	}
	defer c.Close()
	defer func() { c.Logout().Wait() }()

	if _, err := c.Select(acc.Mailbox, &imap.SelectOptions{ReadOnly: true}).Wait(); err != nil {
		return nil, "", fmt.Errorf("%s: select %s: %w", acc.Name, acc.Mailbox, err)
	}
	set := imap.UIDSet{}
	set.AddNum(imap.UID(uid))
	opts := &imap.FetchOptions{
		UID:         true,
		BodySection: []*imap.FetchItemBodySection{{Peek: true}},
	}
	buffers, err := c.Fetch(set, opts).Collect()
	if err != nil {
		return nil, "", err
	}
	if len(buffers) == 0 {
		return nil, "", fmt.Errorf("uid %d not found in %s", uid, acc.Name)
	}
	raw := firstBody(buffers[0])
	if raw == nil {
		return nil, "", fmt.Errorf("empty body for uid %d", uid)
	}

	mr, err := mail.CreateReader(bytes.NewReader(raw))
	if err != nil {
		return nil, "", err
	}
	var only []byte
	var onlyName string
	count := 0
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			break
		}
		h, ok := p.Header.(*mail.AttachmentHeader)
		if !ok {
			continue
		}
		fn, _ := h.Filename()
		data, err := io.ReadAll(p.Body)
		if err != nil {
			return nil, "", err
		}
		if name != "" && fn == name {
			return data, fn, nil
		}
		count++
		only, onlyName = data, fn
	}
	switch {
	case name != "":
		return nil, "", fmt.Errorf("attachment %q not found on message", name)
	case count == 1:
		return only, onlyName, nil
	case count == 0:
		return nil, "", fmt.Errorf("message has no attachments")
	default:
		return nil, "", fmt.Errorf("message has %d attachments; pass -name to pick one", count)
	}
}

// fetchInsert fetches a message set (read-only, BODY.PEEK) and inserts new rows.
// Returns the number inserted and the highest UID seen.
func fetchInsert(c *imapclient.Client, acc config.Account, st *store.Store, set imap.NumSet) (inserted int, maxUID uint32, err error) {
	opts := &imap.FetchOptions{
		UID:         true,
		Envelope:    true,
		Flags:       true,
		BodySection: []*imap.FetchItemBodySection{{Peek: true}}, // never sets \Seen
	}
	buffers, err := c.Fetch(set, opts).Collect()
	if err != nil {
		return 0, 0, err
	}
	for _, b := range buffers {
		m := bufferToMessage(acc, b)
		if uint32(b.UID) > maxUID {
			maxUID = uint32(b.UID)
		}
		ok, err := st.InsertMessage(m)
		if err != nil {
			return inserted, maxUID, err
		}
		if ok {
			inserted++
		}
	}
	return inserted, maxUID, nil
}

// SetSeen marks the given UIDs read or unread ON THE SERVER for one account.
// This is the ONLY operation in spark-cli that writes to the mail server — it
// opens the mailbox read-write (SELECT) and issues a STORE of the \Seen flag.
// Everything else stays read-only.
func SetSeen(acc config.Account, uids []uint32, seen bool) error {
	if len(uids) == 0 {
		return nil
	}
	c, err := dial(acc)
	if err != nil {
		return err
	}
	defer c.Close()
	defer func() { c.Logout().Wait() }()

	// Read-write SELECT (not EXAMINE) so the server accepts the flag change.
	if _, err := c.Select(acc.Mailbox, nil).Wait(); err != nil {
		return fmt.Errorf("%s: select %s: %w", acc.Name, acc.Mailbox, err)
	}
	set := imap.UIDSet{}
	for _, u := range uids {
		set.AddNum(imap.UID(u))
	}
	op := imap.StoreFlagsAdd
	if !seen {
		op = imap.StoreFlagsDel
	}
	flags := &imap.StoreFlags{Op: op, Silent: true, Flags: []imap.Flag{imap.FlagSeen}}
	if err := c.Store(set, flags, nil).Close(); err != nil {
		return fmt.Errorf("%s: store \\Seen: %w", acc.Name, err)
	}
	return nil
}

func bufferToMessage(acc config.Account, b *imapclient.FetchMessageBuffer) *store.Message {
	m := &store.Message{
		Account: acc.Name,
		Mailbox: acc.Mailbox,
		UID:     uint32(b.UID),
	}
	for _, f := range b.Flags {
		if f == imap.FlagSeen {
			m.Seen = true
		}
	}
	if env := b.Envelope; env != nil {
		m.Subject = env.Subject
		m.MessageID = env.MessageID
		m.Date = env.Date
		if len(env.From) > 0 {
			a := env.From[0]
			m.FromName = a.Name
			m.FromAddr = a.Addr()
		}
	}
	if m.Date.IsZero() {
		m.Date = time.Now()
	}

	raw := firstBody(b)
	if raw != nil {
		text, html, atts := extractText(raw)
		m.Body = text
		m.HTML = html
		m.Attachments = atts
		m.Snippet = snippet(text, 200)
	}
	return m
}

// firstBody returns the raw bytes of the first body section in the buffer.
func firstBody(b *imapclient.FetchMessageBuffer) []byte {
	for _, sec := range b.BodySection {
		if len(sec.Bytes) > 0 {
			return sec.Bytes
		}
	}
	return nil
}

// extractText pulls a plain-text rendering and the original HTML out of a raw
// RFC822 message. text prefers text/plain, falling back to HTML rendered to
// text. html is the raw text/html part (empty if none) — kept for the browser
// view.
func extractText(raw []byte) (text, html string, atts []store.Attachment) {
	mr, err := mail.CreateReader(bytes.NewReader(raw))
	if err != nil {
		return string(raw), "", nil
	}
	var plain string
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			break
		}
		switch h := p.Header.(type) {
		case *mail.InlineHeader:
			ct, _, _ := h.ContentType()
			body, _ := io.ReadAll(p.Body)
			switch {
			case strings.HasPrefix(ct, "text/plain") && plain == "":
				plain = string(body)
			case strings.HasPrefix(ct, "text/html") && html == "":
				html = string(body)
			}
		case *mail.AttachmentHeader:
			// Metadata only — the file itself is not stored. Count bytes without
			// holding them in memory.
			name, _ := h.Filename()
			ct, _, _ := h.ContentType()
			n, _ := io.Copy(io.Discard, p.Body)
			if name == "" {
				name = ct
			}
			atts = append(atts, store.Attachment{Name: name, Type: ct, Size: int(n)})
		}
	}
	switch {
	case plain != "":
		text = plain
	case html != "":
		text = htmlToText(html)
	}
	return text, html, atts
}

var (
	reScriptStyle = regexp.MustCompile(`(?is)<script\b[^>]*>.*?</script>|<style\b[^>]*>.*?</style>|<head\b[^>]*>.*?</head>`)
	reBlockTag    = regexp.MustCompile(`(?i)<(br\s*/?|/p|/div|/li|/tr|/h[1-6]|/table|/blockquote)\s*>`)
	reAnyTag      = regexp.MustCompile(`(?s)<[^>]+>`)
	reBlankLines  = regexp.MustCompile(`\n{3,}`)
)

// htmlToText renders HTML to readable plain text: it drops script/style/head,
// turns block-level tags into line breaks, strips the remaining tags, decodes
// HTML entities, and collapses whitespace. Good enough for the reading pane and
// the classifier (the full HTML is kept separately for the browser view).
func htmlToText(s string) string {
	s = reScriptStyle.ReplaceAllString(s, "")
	s = reBlockTag.ReplaceAllString(s, "\n")
	s = reAnyTag.ReplaceAllString(s, "")
	s = nethtml.UnescapeString(s)
	lines := strings.Split(s, "\n")
	for i := range lines {
		lines[i] = strings.Join(strings.Fields(lines[i]), " ") // collapse + trim
	}
	s = strings.Join(lines, "\n")
	return strings.TrimSpace(reBlankLines.ReplaceAllString(s, "\n\n"))
}

// snippet collapses whitespace and truncates to n runes.
func snippet(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= n {
		return s
	}
	return strings.TrimSpace(s[:n]) + "…"
}
