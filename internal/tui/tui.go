// Package tui is the LazyGit-style terminal interface: a category sidebar, a
// message list for the selected category, and a reading pane. Categories are a
// local display grouping only — nothing here writes to the mail server.
//
// Mail is filed by deterministic sender rules (config match blocks); anything
// unmatched is Uncategorized. There is no AI classification in the client.
// Messages can be multi-selected (space) and acted on in bulk: manual move (m)
// or create a sender rule (A).
package tui

import (
	"fmt"
	nethtml "html"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"

	"github.com/iliutaadrian/spark-cli/internal/config"
	"github.com/iliutaadrian/spark-cli/internal/engine"
	"github.com/iliutaadrian/spark-cli/internal/mail"
	"github.com/iliutaadrian/spark-cli/internal/store"
)

// sidebarWidth is the fixed left-column width; the right column (list or reading)
// takes the rest. paneBorders is the horizontal cells consumed by the two pane
// borders (2 each) — content widths plus this must equal the terminal width, or
// lipgloss wraps the body and the layout cascades.
const (
	sidebarWidth = 26
	paneBorders  = 4
)

const allBucket = "\x00all" // sentinel name for the "All" sidebar entry

var (
	titleStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("205"))
	statusStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))
	footerStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))
	paneStyle     = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(lipgloss.Color("240"))
	activePane    = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(lipgloss.Color("205"))
	selectedStyle = lipgloss.NewStyle().Background(lipgloss.Color("205")).Foreground(lipgloss.Color("232"))
	unseenStyle   = lipgloss.NewStyle().Bold(true)
	dimStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))
	headerStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("39")).Bold(true)
	markStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("205")).Bold(true)
	catStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("109"))
)

// viewMode is the top-level screen: the full-width list, or a single opened email.
type viewMode int

const (
	modeList    viewMode = iota // browse the list (no auto-preview)
	modeReading                 // reading one opened email
)

type focusArea int

const (
	focusSidebar focusArea = iota
	focusList
)

// sideKind distinguishes the kinds of rows in the sidebar.
type sideKind int

const (
	kindAll      sideKind = iota // the "All" view (every mailbox)
	kindHeader                   // a non-selectable section label ("Mailboxes"/"Manual"/"AI")
	kindMailbox                  // one account: all of its mail, any category
	kindCategory                 // a real bucket (category, Suggested, Uncategorized)
)

type sideEntry struct {
	kind sideKind
	name string // bucket name for kindCategory; label for kindHeader; "" for All
}

// pickerMode is the active modal category picker, if any.
type pickerMode int

const (
	pickerNone pickerMode = iota
	pickerMove            // assign selected messages to a category manually
	pickerRule            // create a sender rule mapping selected senders -> category
)

type refreshDoneMsg struct {
	newMail    int
	classified int
	err        error
}

type markDoneMsg struct {
	n    int
	seen bool
	err  error
}

type previewDoneMsg struct{ err error }

type model struct {
	st      *store.Store
	cfg     *config.Config
	cfgPath string
	dbPath  string

	msgs      []store.Message
	side      []sideEntry                // ordered sidebar rows (incl. headers + All)
	groups    map[string][]store.Message // category bucket name -> messages
	byAccount map[string][]store.Message // account name -> messages

	catIdx int // index into side (always points at a selectable row)
	msgIdx int
	focus  focusArea
	mode   viewMode // list (default) vs reading an opened email

	selected map[int64]bool // multi-selected message IDs

	// modal category picker
	pmode    pickerMode
	pOptions []string
	pIdx     int

	width, height int
	listW         int // responsive message-list pane width (content cells)
	readW         int // responsive reading pane width (content cells)
	status        string
	busy          bool

	vp    viewport.Model
	ready bool
}

// Run starts the TUI. dbPath is the SQLite file, passed to the inline
// previewer (ink/src/preview.ts) so it can read the message being viewed.
func Run(st *store.Store, cfg *config.Config, cfgPath, dbPath string) error {
	m := &model{
		st: st, cfg: cfg, cfgPath: cfgPath, dbPath: dbPath,
		selected: map[int64]bool{},
		status:   "Press r to fetch new mail",
	}
	m.reload()
	_, err := tea.NewProgram(m, tea.WithAltScreen()).Run()
	return err
}

func (m *model) Init() tea.Cmd { return nil }

// reload pulls all messages from the store and rebuilds the sidebar grouping.
func (m *model) reload() {
	msgs, err := m.st.All()
	if err != nil {
		m.status = "load error: " + err.Error()
		return
	}
	m.msgs = msgs

	groups := map[string][]store.Message{}
	byAccount := map[string][]store.Message{}
	for _, msg := range msgs {
		key := msg.Category
		if key == "" {
			key = store.Uncategorized
		}
		groups[key] = append(groups[key], msg)
		byAccount[msg.Account] = append(byAccount[msg.Account], msg)
	}
	m.groups = groups
	m.byAccount = byAccount

	// Split configured categories into manual (rule-based) and other buckets,
	// keeping only those that currently hold mail.
	var manual, aiCats []string
	for _, c := range m.cfg.Categories {
		if len(groups[c.Name]) == 0 {
			continue
		}
		if c.HasRules() {
			manual = append(manual, c.Name)
		} else {
			aiCats = append(aiCats, c.Name)
		}
	}
	// Approved (promoted) categories sit in the Other section.
	if approved, err := m.st.ApprovedCategories(); err == nil {
		for _, name := range approved {
			if len(groups[name]) > 0 && !contains(aiCats, name) && !contains(manual, name) {
				aiCats = append(aiCats, name)
			}
		}
	}
	// Suggested and Uncategorized live under the Other section.
	if len(groups[store.SuggestedPseudoCategory]) > 0 {
		aiCats = append(aiCats, store.SuggestedPseudoCategory)
	}
	if len(groups[store.Uncategorized]) > 0 {
		aiCats = append(aiCats, store.Uncategorized)
	}

	// Mailbox views: each configured account that currently has mail, in config
	// order. Only shown when there's more than one (with a single account, "All"
	// already is that mailbox).
	var accounts []string
	for _, acc := range m.cfg.Accounts {
		if len(byAccount[acc.Name]) > 0 {
			accounts = append(accounts, acc.Name)
		}
	}

	// Build the ordered sidebar.
	side := []sideEntry{{kind: kindAll, name: allBucket}}
	if len(accounts) > 1 {
		side = append(side, sideEntry{kind: kindHeader, name: "Mailboxes"})
		for _, n := range accounts {
			side = append(side, sideEntry{kind: kindMailbox, name: n})
		}
	}
	if len(manual) > 0 {
		side = append(side, sideEntry{kind: kindHeader, name: "Manual"})
		for _, n := range manual {
			side = append(side, sideEntry{kind: kindCategory, name: n})
		}
	}
	if len(aiCats) > 0 {
		side = append(side, sideEntry{kind: kindHeader, name: "Other"})
		for _, n := range aiCats {
			side = append(side, sideEntry{kind: kindCategory, name: n})
		}
	}
	m.side = side

	// Keep catIdx on a selectable row.
	if m.catIdx >= len(m.side) {
		m.catIdx = len(m.side) - 1
	}
	if m.catIdx < 0 {
		m.catIdx = 0
	}
	if m.side[m.catIdx].kind == kindHeader {
		m.catIdx = m.nextSelectable(m.catIdx, +1)
	}
	m.clampMsg()
	m.syncViewport()
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

// nextSelectable returns the index of the next selectable row from idx in the
// given direction (+1/-1), skipping headers. Falls back to idx if none.
func (m *model) nextSelectable(idx, dir int) int {
	i := idx + dir
	for i >= 0 && i < len(m.side) {
		if m.side[i].kind != kindHeader {
			return i
		}
		i += dir
	}
	// Nothing in that direction; scan the other way from idx.
	i = idx
	for i >= 0 && i < len(m.side) {
		if m.side[i].kind != kindHeader {
			return i
		}
		i -= dir
	}
	return idx
}

func (m *model) currentEntry() sideEntry {
	if m.catIdx < 0 || m.catIdx >= len(m.side) {
		return sideEntry{kind: kindAll, name: allBucket}
	}
	return m.side[m.catIdx]
}

func (m *model) currentMessages() []store.Message {
	e := m.currentEntry()
	switch e.kind {
	case kindAll:
		return m.msgs
	case kindMailbox:
		return m.byAccount[e.name]
	default:
		return m.groups[e.name]
	}
}

func (m *model) currentMessage() *store.Message {
	msgs := m.currentMessages()
	if m.msgIdx < 0 || m.msgIdx >= len(msgs) {
		return nil
	}
	return &msgs[m.msgIdx]
}

func (m *model) clampMsg() {
	n := len(m.currentMessages())
	if m.msgIdx >= n {
		m.msgIdx = max(0, n-1)
	}
	if m.msgIdx < 0 {
		m.msgIdx = 0
	}
}

// targetIDs is what a bulk action operates on: the multi-selection if any,
// otherwise the currently highlighted message.
func (m *model) targetIDs() []int64 {
	if len(m.selected) > 0 {
		ids := make([]int64, 0, len(m.selected))
		for id := range m.selected {
			ids = append(ids, id)
		}
		return ids
	}
	if msg := m.currentMessage(); msg != nil {
		return []int64{msg.ID}
	}
	return nil
}

func (m *model) syncViewport() {
	if !m.ready {
		return
	}
	msg := m.currentMessage()
	if msg == nil {
		m.vp.SetContent(dimStyle.Render("No message selected."))
		return
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Mailbox: %s\n", msg.Account)
	fmt.Fprintf(&b, "From:    %s <%s>\n", msg.FromName, msg.FromAddr)
	fmt.Fprintf(&b, "Subject: %s\n", msg.Subject)
	fmt.Fprintf(&b, "Date:    %s\n", msg.Date.Format("Mon 2 Jan 2006 15:04"))
	cat := msg.Category
	if cat == "" {
		cat = store.Uncategorized
	}
	src := ""
	switch msg.Source {
	case store.SourceRule:
		src = "  [rule]"
	case store.SourceAI:
		src = "  [AI]"
	case store.SourceManual:
		src = "  [manual]"
	}
	if msg.SuggestedNew != "" {
		fmt.Fprintf(&b, "Category: %s → proposes %q  (press p to approve)\n", cat, msg.SuggestedNew)
	} else {
		fmt.Fprintf(&b, "Category: %s%s\n", cat, src)
	}
	if strings.TrimSpace(msg.HTML) != "" {
		fmt.Fprintf(&b, "%s\n", dimStyle.Render("HTML email — press v to open it in your browser"))
	}
	for _, a := range msg.Attachments {
		fmt.Fprintf(&b, "📎 %s  %s  %s\n", a.Name, a.Type, humanSize(a.Size))
	}
	b.WriteString(strings.Repeat("─", max(10, m.vp.Width)) + "\n\n")
	body := msg.Body
	if body == "" {
		body = msg.Snippet
	}
	b.WriteString(body)
	// Same width normalization as the list: optional-emoji symbols in bodies
	// otherwise render wider than counted and wrap the reading pane.
	m.vp.SetContent(emojiPresentation(b.String()))
	m.vp.GotoTop()
}

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.layout()
		m.ready = true
		m.syncViewport()
		return m, nil

	case refreshDoneMsg:
		m.busy = false
		if msg.err != nil {
			m.status = "error: " + msg.err.Error()
		} else {
			m.status = fmt.Sprintf("Fetched %d new, %d filed by rules — %s",
				msg.newMail, msg.classified, time.Now().Format("15:04:05"))
		}
		m.reload()
		return m, nil

	case markDoneMsg:
		m.busy = false
		if msg.err != nil {
			m.status = "mark error: " + msg.err.Error()
		} else {
			state := "read"
			if !msg.seen {
				state = "unread"
			}
			m.status = fmt.Sprintf("Marked %d %s on server", msg.n, state)
		}
		m.selected = map[int64]bool{}
		m.reload()
		return m, nil

	case previewDoneMsg:
		if msg.err != nil {
			m.status = "preview error: " + msg.err.Error()
		}
		return m, nil

	case tea.KeyMsg:
		if m.pmode != pickerNone {
			return m.handlePicker(msg)
		}
		return m.handleKey(msg)
	}
	return m, nil
}

func (m *model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.mode == modeReading {
		return m.handleReadingKey(msg)
	}
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "enter": // open the highlighted email
		if m.currentMessage() != nil {
			m.mode = modeReading
			m.syncViewport()
		}
	case "r":
		if !m.busy {
			m.busy = true
			m.status = "Fetching new mail…"
			return m, m.refreshCmd()
		}
	case "tab", "left", "right", "h", "l":
		if m.focus == focusSidebar {
			m.focus = focusList
		} else {
			m.focus = focusSidebar
		}
	case "up", "k":
		m.moveUp()
	case "down", "j":
		m.moveDown()
	case " ": // toggle selection of the highlighted message
		if msg := m.currentMessage(); msg != nil {
			if m.selected[msg.ID] {
				delete(m.selected, msg.ID)
			} else {
				m.selected[msg.ID] = true
			}
			m.moveDown() // LazyGit-style: advance after marking
		}
	case "p":
		m.promote()
	case "v": // open the full HTML email in the default browser
		m.openInBrowser()
	case "i": // render the highlighted email inline in the terminal
		if cmd := m.previewCmd(); cmd != nil {
			return m, cmd
		}
	case "M": // mark targets READ on the server (writes to server)
		if len(m.targetIDs()) > 0 && !m.busy {
			m.busy = true
			m.status = "Marking read on server…"
			return m, m.markSeenCmd(true)
		}
	case "U": // mark targets UNREAD on the server (writes to server)
		if len(m.targetIDs()) > 0 && !m.busy {
			m.busy = true
			m.status = "Marking unread on server…"
			return m, m.markSeenCmd(false)
		}
	case "m": // manual move to a category
		if len(m.targetIDs()) > 0 {
			m.openPicker(pickerMove)
		}
	case "A": // create a sender rule from the targets
		if len(m.targetIDs()) > 0 {
			m.openPicker(pickerRule)
		}
	case "esc":
		m.selected = map[int64]bool{}
	case "ctrl+d", "pgdown":
		m.vp.HalfPageDown()
	case "ctrl+u", "pgup":
		m.vp.HalfPageUp()
	}
	return m, nil
}

// handleReadingKey handles keys while an email is open. Esc/left/backspace/q
// return to the list; j/k move to the next/previous email; ctrl+u/d scroll.
func (m *model) handleReadingKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "q", "h", "left", "backspace":
		m.mode = modeList
	case "ctrl+c":
		return m, tea.Quit
	case "down", "j": // next email
		m.moveDown()
		m.syncViewport()
	case "up", "k": // previous email
		m.moveUp()
		m.syncViewport()
	case "ctrl+d", "pgdown":
		m.vp.HalfPageDown()
	case "ctrl+u", "pgup":
		m.vp.HalfPageUp()
	case "v": // open the full HTML in the browser
		m.openInBrowser()
	case "i": // render the email inline in the terminal (Ghostty/kitty graphics)
		if cmd := m.previewCmd(); cmd != nil {
			return m, cmd
		}
	case "M":
		if len(m.targetIDs()) > 0 && !m.busy {
			m.busy = true
			m.status = "Marking read on server…"
			return m, m.markSeenCmd(true)
		}
	case "U":
		if len(m.targetIDs()) > 0 && !m.busy {
			m.busy = true
			m.status = "Marking unread on server…"
			return m, m.markSeenCmd(false)
		}
	case "p":
		m.promote()
	}
	return m, nil
}

// previewCmd suspends the TUI and renders the current email inline via the
// shared previewer (ink/src/preview.ts: HTML → PNG → chafa). tea.ExecProcess
// hands the terminal to the child and restores + repaints on return, so no
// manual raw-mode/redraw juggling is needed.
func (m *model) previewCmd() tea.Cmd {
	msg := m.currentMessage()
	if msg == nil {
		return nil
	}
	script := filepath.Join(filepath.Dir(m.cfgPath), "ink", "src", "preview.ts")
	if _, err := os.Stat(script); err != nil {
		m.status = "preview needs ink/src/preview.ts (and bun + chafa)"
		return nil
	}
	c := exec.Command("bun", script, m.dbPath, fmt.Sprint(msg.ID))
	return tea.ExecProcess(c, func(err error) tea.Msg { return previewDoneMsg{err} })
}

// --- modal category picker ---

func (m *model) openPicker(mode pickerMode) {
	cats, err := engine.Categories(m.st, m.cfg)
	if err != nil || len(cats) == 0 {
		m.status = "no categories to choose from"
		return
	}
	m.pOptions = m.pOptions[:0]
	for _, c := range cats {
		m.pOptions = append(m.pOptions, c.Name)
	}
	m.pmode = mode
	m.pIdx = 0
}

func (m *model) handlePicker(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.pmode = pickerNone
	case "up", "k":
		if m.pIdx > 0 {
			m.pIdx--
		}
	case "down", "j":
		if m.pIdx < len(m.pOptions)-1 {
			m.pIdx++
		}
	case "enter":
		choice := m.pOptions[m.pIdx]
		mode := m.pmode
		m.pmode = pickerNone
		return m.applyPicker(mode, choice)
	}
	return m, nil
}

func (m *model) applyPicker(mode pickerMode, choice string) (tea.Model, tea.Cmd) {
	ids := m.targetIDs()
	switch mode {
	case pickerMove:
		if err := m.st.SetCategoryManual(ids, choice); err != nil {
			m.status = "move error: " + err.Error()
		} else {
			m.status = fmt.Sprintf("Moved %d to %q", len(ids), choice)
		}
	case pickerRule:
		if err := m.createRule(ids, choice); err != nil {
			m.status = "rule error: " + err.Error()
		}
	}
	m.selected = map[int64]bool{}
	m.reload()
	return m, nil
}

// createRule turns the senders of the given messages into a domain rule for
// category choice: it writes the rule to config.yaml, reloads config, and
// re-homes all matching mail (no AI).
func (m *model) createRule(ids []int64, choice string) error {
	byID := map[int64]store.Message{}
	for _, msg := range m.msgs {
		byID[msg.ID] = msg
	}
	domainSet := map[string]bool{}
	for _, id := range ids {
		if d := config.DomainOf(byID[id].FromAddr); d != "" {
			domainSet[d] = true
		}
	}
	if len(domainSet) == 0 {
		return fmt.Errorf("no sender domains in selection")
	}
	domains := make([]string, 0, len(domainSet))
	for d := range domainSet {
		domains = append(domains, d)
	}
	sort.Strings(domains)

	if err := config.AddSenderRule(m.cfgPath, choice, domains, nil); err != nil {
		return err
	}
	// Reload config from disk so the new rule is in effect, then apply it.
	newCfg, err := config.Load(m.cfgPath)
	if err != nil {
		return fmt.Errorf("reload config: %w", err)
	}
	m.cfg = newCfg
	n, err := engine.ApplyRules(m.st, m.cfg)
	if err != nil {
		return err
	}
	m.status = fmt.Sprintf("Rule: %s → %q (%d emails moved)", strings.Join(domains, ", "), choice, n)
	return nil
}

// moveUp/moveDown change the selection only. They do NOT refresh the reading
// pane — the email is shown on demand (Enter), not auto-previewed. In reading
// mode the caller re-syncs the viewport to page through emails.
func (m *model) moveUp() {
	if m.focus == focusSidebar {
		if i := m.nextSelectable(m.catIdx, -1); i != m.catIdx {
			m.catIdx = i
			m.msgIdx = 0
			m.clampMsg()
		}
		return
	}
	if m.msgIdx > 0 {
		m.msgIdx--
	}
}

func (m *model) moveDown() {
	if m.focus == focusSidebar {
		if i := m.nextSelectable(m.catIdx, +1); i != m.catIdx {
			m.catIdx = i
			m.msgIdx = 0
			m.clampMsg()
		}
		return
	}
	if m.msgIdx < len(m.currentMessages())-1 {
		m.msgIdx++
	}
}

// promote approves the AI's suggested category for the selected message.
func (m *model) promote() {
	msg := m.currentMessage()
	if msg == nil || msg.SuggestedNew == "" {
		return
	}
	name := msg.SuggestedNew
	if err := m.st.PromoteSuggestion(name, ""); err != nil {
		m.status = "promote error: " + err.Error()
		return
	}
	m.status = fmt.Sprintf("Approved category %q", name)
	m.reload()
}

// openInBrowser writes the selected email's HTML (or its text wrapped in HTML)
// to a temp file and opens it in the default browser for full rendering with
// images and layout. Read-only: it only reads the local copy.
func (m *model) openInBrowser() {
	msg := m.currentMessage()
	if msg == nil {
		return
	}
	var doc string
	if strings.TrimSpace(msg.HTML) != "" {
		doc = msg.HTML
	} else {
		doc = "<!doctype html><meta charset=utf-8><pre style=\"white-space:pre-wrap;font:14px/1.5 system-ui\">" +
			nethtml.EscapeString(msg.Body) + "</pre>"
	}
	path := filepath.Join(os.TempDir(), "spark-cli-preview.html")
	if err := os.WriteFile(path, []byte(doc), 0o600); err != nil {
		m.status = "preview error: " + err.Error()
		return
	}
	opener := "xdg-open"
	if runtime.GOOS == "darwin" {
		opener = "open"
	}
	if err := exec.Command(opener, path).Start(); err != nil {
		m.status = "open error: " + err.Error()
		return
	}
	m.status = "Opened HTML in browser"
}

func (m *model) refreshCmd() tea.Cmd {
	return func() tea.Msg {
		newMail, filed, err := engine.Refresh(m.st, m.cfg)
		return refreshDoneMsg{newMail: newMail, classified: filed, err: err}
	}
}

// markSeenCmd marks the target messages read/unread on the server, grouped by
// account into one connection each, and mirrors the flag locally. This writes
// to the mail server (the only action that does).
func (m *model) markSeenCmd(seen bool) tea.Cmd {
	ids := m.targetIDs()
	msgByID := make(map[int64]store.Message, len(m.msgs))
	for _, mm := range m.msgs {
		msgByID[mm.ID] = mm
	}
	accByName := make(map[string]config.Account, len(m.cfg.Accounts))
	for _, a := range m.cfg.Accounts {
		accByName[a.Name] = a
	}
	st := m.st
	return func() tea.Msg {
		uidsByAcc := map[string][]uint32{}
		idsByAcc := map[string][]int64{}
		for _, id := range ids {
			mm, ok := msgByID[id]
			if !ok {
				continue
			}
			uidsByAcc[mm.Account] = append(uidsByAcc[mm.Account], mm.UID)
			idsByAcc[mm.Account] = append(idsByAcc[mm.Account], id)
		}
		for accName, uids := range uidsByAcc {
			acc, ok := accByName[accName]
			if !ok {
				continue
			}
			if err := mail.SetSeen(acc, uids, seen); err != nil {
				return markDoneMsg{err: err}
			}
			for _, id := range idsByAcc[accName] {
				_ = st.SetSeen(id, seen)
			}
		}
		return markDoneMsg{n: len(ids), seen: seen}
	}
}

// layout sizes the panes to the terminal. Two columns: the sidebar and, to its
// right, EITHER the message list or the opened email (depending on mode). Each
// pane has a 2-column border, so the right column width = width - sidebar - 4,
// filling the terminal exactly (no overflow, which would wrap and cascade).
func (m *model) layout() {
	bodyHeight := m.height - 4 // header + footer + borders
	if bodyHeight < 3 {
		bodyHeight = 3
	}
	right := m.width - sidebarWidth - paneBorders
	if right < 16 {
		right = 16
	}
	m.listW, m.readW = right, right

	if !m.ready {
		m.vp = viewport.New(right, bodyHeight)
	} else {
		m.vp.Width = right
		m.vp.Height = bodyHeight
	}
}

func (m *model) View() string {
	if !m.ready {
		return "Loading…"
	}
	if m.pmode != pickerNone {
		return m.viewPicker()
	}
	bodyHeight := m.height - 4
	if bodyHeight < 3 {
		bodyHeight = 3
	}

	header := titleStyle.Render("spark-cli") + "  " +
		statusStyle.Render(truncPlain(m.status, max(0, m.width-11)))

	sb := pane(m.focus == focusSidebar && m.mode == modeList).
		Width(sidebarWidth).Height(bodyHeight).Render(m.renderSidebar(bodyHeight))

	var rightCol, hint string
	if m.mode == modeReading {
		rightCol = activePane.Width(m.readW).Height(bodyHeight).Render(m.renderReading(bodyHeight))
		hint = "j/k next/prev · ctrl+u/d scroll · i preview · v html · M/U read · esc/q back"
	} else {
		rightCol = pane(m.focus == focusList).Width(m.listW).Height(bodyHeight).Render(m.renderList(m.listW, bodyHeight))
		sel := ""
		if len(m.selected) > 0 {
			sel = fmt.Sprintf(" · %d selected", len(m.selected))
		}
		hint = "enter open · i preview · space select · r refresh · m move · A rule · M/U read · q quit" + sel
	}

	body := lipgloss.JoinHorizontal(lipgloss.Top, sb, rightCol)
	footer := footerStyle.Render(truncPlain(hint, m.width))
	out := header + "\n" + body + "\n" + footer
	// Insurance: never emit more lines than the terminal has. A frame taller
	// than the terminal scrolls it, and bubbletea's line-diff renderer never
	// recovers — stale rows stay behind as ghost duplicates.
	if lines := strings.Split(out, "\n"); len(lines) > m.height {
		out = strings.Join(lines[:m.height], "\n")
	}
	return out
}

func (m *model) viewPicker() string {
	var title string
	switch m.pmode {
	case pickerMove:
		title = fmt.Sprintf("Move %d email(s) to category:", len(m.targetIDs()))
	case pickerRule:
		title = fmt.Sprintf("Create sender rule → category (%d email(s)):", len(m.targetIDs()))
	}
	var b strings.Builder
	b.WriteString(titleStyle.Render(title) + "\n\n")
	for i, opt := range m.pOptions {
		line := "  " + opt
		if i == m.pIdx {
			line = selectedStyle.Render(fit("> "+opt, 30))
		}
		b.WriteString(line + "\n")
	}
	b.WriteString("\n" + footerStyle.Render("j/k move · enter choose · esc cancel"))
	box := activePane.Padding(1, 2).Render(b.String())
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, box)
}

func pane(active bool) lipgloss.Style {
	if active {
		return activePane
	}
	return paneStyle
}

func (m *model) renderSidebar(h int) string {
	if len(m.side) == 0 {
		return dimStyle.Render("(no mail yet)\npress r")
	}
	var lines []string
	for i, e := range m.side {
		switch e.kind {
		case kindHeader:
			lines = append(lines, headerStyle.Render(fit("── "+e.name+" ", sidebarWidth-2)))
		case kindAll:
			label := fmt.Sprintf("All (%d)", len(m.msgs))
			lines = append(lines, sideLabel(label, i == m.catIdx))
		case kindMailbox:
			label := fmt.Sprintf("%s (%d)", e.name, len(m.byAccount[e.name]))
			lines = append(lines, sideLabel(label, i == m.catIdx))
		case kindCategory:
			label := fmt.Sprintf("%s (%d)", e.name, len(m.groups[e.name]))
			lines = append(lines, sideLabel(label, i == m.catIdx))
		}
	}
	return clip(lines, h)
}

func sideLabel(label string, selected bool) string {
	if selected {
		return selectedStyle.Render(fit(label, sidebarWidth-2))
	}
	return fit(label, sidebarWidth-2)
}

func (m *model) renderList(w, h int) string {
	msgs := m.currentMessages()
	if len(msgs) == 0 {
		return dimStyle.Render("(empty)")
	}
	// Column widths within the row; the subject takes whatever is left. On a
	// narrow pane shed the category column, then shrink the sender, so the
	// fixed columns can never exceed the row width — an over-wide row wraps
	// inside the pane, grows the frame past the terminal height, and desyncs
	// the renderer into ghost rows.
	const dateW = 6 // "Jan 02"
	senderW, catW := 18, 13
	if w < 72 {
		catW = 0
	}
	if w < 48 {
		senderW = 10
	}
	fixed := 2 + 1 + senderW + 1 + dateW + 1 // marks + sender + date + spaces
	if catW > 0 {
		fixed += catW + 1
	}
	subjW := w - fixed
	if subjW < 0 {
		subjW = 0
	}

	// Build ONLY the visible window of rows. The list can hold tens of
	// thousands of messages; styling all of them on every keystroke (and then
	// clipping to ~25) makes scrolling crawl.
	start := 0
	if len(msgs) > h {
		start = m.msgIdx - h/2
		if start < 0 {
			start = 0
		}
		if start+h > len(msgs) {
			start = len(msgs) - h
		}
	}
	end := start + h
	if end > len(msgs) {
		end = len(msgs)
	}

	lines := make([]string, 0, end-start)
	for i := start; i < end; i++ {
		msg := msgs[i]
		from := oneLine(msg.FromName)
		if from == "" {
			from = oneLine(msg.FromAddr)
		}
		subj := oneLine(msg.Subject)
		if subj == "" {
			subj = "(no subject)"
		}
		cat := msg.Category
		if cat == "" {
			cat = "—"
		}
		// Prefix: selection marker + read/unread dot.
		selCh, readCh := " ", " "
		if m.selected[msg.ID] {
			selCh = "●"
		}
		if !msg.Seen {
			readCh = "•"
		}
		sender := fit(from, senderW)
		subject := fit(subj, subjW)
		date := fit(msg.Date.Format("Jan 02"), dateW)
		plainCat, styledCat := "", ""
		if catW > 0 {
			c := fit(cat, catW)
			plainCat = c + " "
			styledCat = catStyle.Render(c) + " "
		}

		if i == m.msgIdx {
			// Cursor row: plain text, highlighted across the full width.
			plain := fit(selCh+readCh+" "+sender+" "+plainCat+subject+" "+date, w)
			lines = append(lines, selectedStyle.Render(plain))
			continue
		}
		// Colored segments: pink selection dot, category tinted, date dimmed.
		// Unread rows bold the sender + subject (styling the whole composed row
		// wouldn't survive the embedded resets of the inner segments).
		sendSeg, subjSeg := sender, subject
		if !msg.Seen {
			sendSeg, subjSeg = unseenStyle.Render(sender), unseenStyle.Render(subject)
		}
		row := markStyle.Render(selCh) + readCh + " " + sendSeg + " " +
			styledCat + subjSeg + " " + dimStyle.Render(date)
		// Hard clamp (ANSI-aware): a row must never exceed the pane width.
		lines = append(lines, ansi.Truncate(row, w, ""))
	}
	return strings.Join(lines, "\n")
}

func (m *model) renderReading(h int) string {
	return m.vp.View()
}

// --- small helpers ---

// fit truncates s to exactly w display cells (not runes) and right-pads with
// spaces. Widths MUST be measured with x/ansi — the same grapheme-aware measure
// lipgloss and bubbletea use. go-runewidth disagrees with it on VS16 emoji
// ("❤️"), ZWJ sequences and flag emoji, and a row even 1 cell over-wide wraps
// inside the pane, makes the frame taller than the terminal, and permanently
// desyncs the renderer (ghost rows).
func fit(s string, w int) string {
	if w <= 0 {
		return ""
	}
	s = ansi.Truncate(s, w, "…")
	if pad := w - ansi.StringWidth(s); pad > 0 {
		s += strings.Repeat(" ", pad)
	}
	return s
}

func clip(lines []string, h int) string {
	if len(lines) > h {
		lines = lines[:h]
	}
	return strings.Join(lines, "\n")
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// humanSize formats a byte count as a short human-readable string.
func humanSize(n int) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}

// oneLine flattens a string to a single line by turning newlines, carriage
// returns and tabs into spaces — email subjects/names sometimes contain these,
// and an embedded newline would break the fixed-height list layout.
func oneLine(s string) string {
	return emojiPresentation(strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		return r
	}, s))
}

// optionalEmoji holds BMP symbols with OPTIONAL emoji presentation (Emoji=Yes,
// Emoji_Presentation=No in Unicode emoji-data, minus ©®™ℹ which are near
// universally text-rendered). Terminals disagree on their width: uniseg (and
// lipgloss/bubbletea) count 1 cell, but e.g. tmux built with utf8proc draws
// some of them ("✍" in real eMAG subjects) 2 cells wide. A row even one
// physical cell over-wide wraps, scrolls the terminal, and permanently
// desyncs bubbletea's renderer into ghost rows.
var optionalEmoji = &unicode.RangeTable{
	R16: []unicode.Range16{
		{0x203C, 0x203C, 1}, {0x2049, 0x2049, 1},
		{0x2194, 0x2199, 1}, {0x21A9, 0x21AA, 1},
		{0x2328, 0x2328, 1}, {0x23CF, 0x23CF, 1},
		{0x23ED, 0x23EF, 1}, {0x23F1, 0x23F2, 1}, {0x23F8, 0x23FA, 1},
		{0x25AA, 0x25AB, 1}, {0x25B6, 0x25B6, 1}, {0x25C0, 0x25C0, 1},
		{0x25FB, 0x25FC, 1},
		{0x2600, 0x2604, 1}, {0x260E, 0x260E, 1}, {0x2611, 0x2611, 1},
		{0x2618, 0x2618, 1}, {0x261D, 0x261D, 1}, {0x2620, 0x2620, 1},
		{0x2622, 0x2623, 1}, {0x2626, 0x2626, 1}, {0x262A, 0x262A, 1},
		{0x262E, 0x262F, 1}, {0x2638, 0x263A, 1}, {0x2640, 0x2640, 1},
		{0x2642, 0x2642, 1}, {0x265F, 0x2660, 1}, {0x2663, 0x2663, 1},
		{0x2665, 0x2666, 1}, {0x2668, 0x2668, 1}, {0x267B, 0x267B, 1},
		{0x267E, 0x267E, 1}, {0x2692, 0x2692, 1}, {0x2694, 0x2697, 1},
		{0x2699, 0x2699, 1}, {0x269B, 0x269C, 1}, {0x26A0, 0x26A0, 1},
		{0x26A7, 0x26A7, 1}, {0x26B0, 0x26B1, 1}, {0x26C8, 0x26C8, 1},
		{0x26CF, 0x26CF, 1}, {0x26D1, 0x26D1, 1}, {0x26D3, 0x26D3, 1},
		{0x26E9, 0x26E9, 1}, {0x26F0, 0x26F1, 1}, {0x26F4, 0x26F4, 1},
		{0x26F7, 0x26F9, 1},
		{0x2702, 0x2702, 1}, {0x2708, 0x2709, 1}, {0x270C, 0x270D, 1},
		{0x270F, 0x270F, 1}, {0x2712, 0x2712, 1}, {0x2714, 0x2714, 1},
		{0x2716, 0x2716, 1}, {0x271D, 0x271D, 1}, {0x2721, 0x2721, 1},
		{0x2733, 0x2734, 1}, {0x2744, 0x2744, 1}, {0x2747, 0x2747, 1},
		{0x2763, 0x2764, 1}, {0x27A1, 0x27A1, 1},
		{0x2934, 0x2935, 1}, {0x2B05, 0x2B07, 1},
		{0x3030, 0x3030, 1}, {0x303D, 0x303D, 1},
		{0x3297, 0x3297, 1}, {0x3299, 0x3299, 1},
	},
}

// emojiPresentation appends VS16 (U+FE0F) to optional-emoji symbols that don't
// already carry a variation selector, forcing explicit emoji presentation.
// Then every width authority (uniseg, utf8proc, emoji-font terminals) agrees
// on 2 cells and rows can't silently overflow the pane.
func emojiPresentation(s string) string {
	if !strings.ContainsFunc(s, func(r rune) bool { return unicode.Is(optionalEmoji, r) }) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s) + 8)
	runes := []rune(s)
	for i, r := range runes {
		b.WriteRune(r)
		if unicode.Is(optionalEmoji, r) {
			if i+1 < len(runes) && (runes[i+1] == 0xFE0E || runes[i+1] == 0xFE0F) {
				continue // presentation already explicit
			}
			b.WriteRune(0xFE0F)
		}
	}
	return b.String()
}

// truncPlain truncates a string to w display cells with an ellipsis (no
// padding), ANSI-aware and measured like lipgloss/bubbletea (see fit).
func truncPlain(s string, w int) string {
	if w <= 0 {
		return ""
	}
	return ansi.Truncate(s, w, "…")
}
