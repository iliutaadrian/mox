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

// Sync connects to one account, fetches messages newer than what's stored, and
// inserts them. Returns how many new messages were inserted.
func Sync(st *store.Store, acc config.Account, fetchLimit int) (int, error) {
	addr := fmt.Sprintf("%s:%d", acc.IMAPHost, acc.IMAPPort)
	var dialOpts *imapclient.Options
	if os.Getenv("SPARK_IMAP_DEBUG") != "" {
		dialOpts = &imapclient.Options{DebugWriter: os.Stderr}
	}
	c, err := imapclient.DialTLS(addr, dialOpts)
	if err != nil {
		return 0, fmt.Errorf("%s: dial: %w", acc.Name, err)
	}
	defer c.Close()

	if err := c.Login(acc.IMAPUser, acc.IMAPPass).Wait(); err != nil {
		return 0, fmt.Errorf("%s: login: %w", acc.Name, err)
	}
	// NOTE: must be a closure. `defer c.Logout().Wait()` would evaluate the
	// receiver c.Logout() immediately — sending LOGOUT right after login and
	// killing the connection before SELECT runs.
	defer func() { c.Logout().Wait() }()

	// Yahoo (and AOL) silently drop the connection on the next command unless the
	// client first identifies itself with an IMAP ID (RFC 2971). Best-effort:
	// servers without the ID extension just reject it, which is harmless here.
	c.ID(&imap.IDData{Name: "spark-cli", Version: "1.0"}).Wait()

	// ReadOnly issues EXAMINE, not SELECT — the server refuses any flag change,
	// so fetching can never mark messages as \Seen (read).
	sel, err := c.Select(acc.Mailbox, &imap.SelectOptions{ReadOnly: true}).Wait()
	if err != nil {
		return 0, fmt.Errorf("%s: select %s: %w", acc.Name, acc.Mailbox, err)
	}

	storedValidity, lastUID, err := st.SyncState(acc.Name, acc.Mailbox)
	if err != nil {
		return 0, err
	}

	// If UIDVALIDITY changed, the server's UIDs are no longer comparable to
	// ours — wipe and re-sync from scratch.
	if storedValidity != 0 && storedValidity != sel.UIDValidity {
		if err := st.ResetMailbox(acc.Name, acc.Mailbox); err != nil {
			return 0, err
		}
		lastUID = 0
	}

	numSet, fetchKind, err := buildFetchSet(sel, lastUID, fetchLimit)
	if err != nil {
		return 0, err
	}
	if numSet == nil {
		// Nothing new.
		return 0, st.SetSyncState(acc.Name, acc.Mailbox, sel.UIDValidity, lastUID)
	}

	opts := &imap.FetchOptions{
		UID:         true,
		Envelope:    true,
		Flags:       true,
		BodySection: []*imap.FetchItemBodySection{{Peek: true}}, // BODY.PEEK[] — never sets \Seen
	}
	buffers, err := c.Fetch(numSet, opts).Collect()
	if err != nil {
		return 0, fmt.Errorf("%s: fetch (%s): %w", acc.Name, fetchKind, err)
	}

	inserted := 0
	maxUID := lastUID
	for _, b := range buffers {
		m := bufferToMessage(acc, b)
		if uint32(b.UID) > maxUID {
			maxUID = uint32(b.UID)
		}
		ok, err := st.InsertMessage(m)
		if err != nil {
			return inserted, err
		}
		if ok {
			inserted++
		}
	}

	if err := st.SetSyncState(acc.Name, acc.Mailbox, sel.UIDValidity, maxUID); err != nil {
		return inserted, err
	}
	return inserted, nil
}

// buildFetchSet decides which messages to pull. Cold mailbox (lastUID==0):
// the most recent fetchLimit messages by sequence number. Warm: UIDs above
// lastUID. Returns (nil, ...) when there is nothing to fetch.
func buildFetchSet(sel *imap.SelectData, lastUID uint32, fetchLimit int) (imap.NumSet, string, error) {
	if sel.NumMessages == 0 {
		return nil, "", nil
	}
	if lastUID == 0 {
		limit := uint32(fetchLimit)
		start := uint32(1)
		if sel.NumMessages > limit {
			start = sel.NumMessages - limit + 1
		}
		set := imap.SeqSet{}
		set.AddRange(start, sel.NumMessages)
		return set, "cold", nil
	}
	set := imap.UIDSet{}
	set.AddRange(imap.UID(lastUID+1), 0) // 0 == "*" (open-ended)
	return set, "incremental", nil
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
		text, html := extractText(raw)
		m.Body = text
		m.HTML = html
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
func extractText(raw []byte) (text, html string) {
	mr, err := mail.CreateReader(bytes.NewReader(raw))
	if err != nil {
		return string(raw), ""
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
		ih, ok := p.Header.(*mail.InlineHeader)
		if !ok {
			continue
		}
		ct, _, _ := ih.ContentType()
		body, _ := io.ReadAll(p.Body)
		switch {
		case strings.HasPrefix(ct, "text/plain") && plain == "":
			plain = string(body)
		case strings.HasPrefix(ct, "text/html") && html == "":
			html = string(body)
		}
	}
	switch {
	case plain != "":
		text = plain
	case html != "":
		text = htmlToText(html)
	}
	return text, html
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
