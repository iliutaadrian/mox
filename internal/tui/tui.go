// Package tui is the LazyGit-style terminal interface: a category sidebar, a
// message list for the selected category, and a reading pane. AI categories
// are a local display grouping only (Spark-style) — nothing here writes to the
// mail server.
//
// The sidebar separates Manual (rule-based) categories from AI ones, plus an
// "All" view. Messages can be multi-selected (space) and acted on in bulk:
// AI re-categorize (R), manual move (m), or create a sender rule (A).
package tui

import (
	"context"
	"fmt"
	nethtml "html"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-runewidth"

	"github.com/iliutaadrian/spark-cli/internal/ai"
	"github.com/iliutaadrian/spark-cli/internal/config"
	"github.com/iliutaadrian/spark-cli/internal/engine"
	"github.com/iliutaadrian/spark-cli/internal/store"
)

const (
	sidebarWidth = 26
	listWidth    = 40
	// paneBorders is the horizontal cells consumed by the three pane borders
	// (2 each). The content widths plus this must equal the terminal width, or
	// lipgloss wraps the body and the layout cascades when the list fills.
	paneBorders = 6
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
	pickerMove                // assign selected messages to a category manually
	pickerRule                // create a sender rule mapping selected senders -> category
)

type refreshDoneMsg struct {
	newMail    int
	classified int
	err        error
}

type model struct {
	st      *store.Store
	cfg     *config.Config
	cls     *ai.Classifier
	cfgPath string

	msgs      []store.Message
	side      []sideEntry                // ordered sidebar rows (incl. headers + All)
	groups    map[string][]store.Message // category bucket name -> messages
	byAccount map[string][]store.Message // account name -> messages

	catIdx int // index into side (always points at a selectable row)
	msgIdx int
	focus  focusArea

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

// Run starts the TUI.
func Run(st *store.Store, cfg *config.Config, cls *ai.Classifier, cfgPath string) error {
	m := &model{
		st: st, cfg: cfg, cls: cls, cfgPath: cfgPath,
		selected: map[int64]bool{},
		status:   "Press r to fetch + classify",
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

	// Split configured categories into manual (rule-based) and AI buckets,
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
	// Approved (promoted) categories are AI-side.
	if approved, err := m.st.ApprovedCategories(); err == nil {
		for _, name := range approved {
			if len(groups[name]) > 0 && !contains(aiCats, name) && !contains(manual, name) {
				aiCats = append(aiCats, name)
			}
		}
	}
	// Suggested and Uncategorized live under the AI section.
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
		side = append(side, sideEntry{kind: kindHeader, name: "AI"})
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
	b.WriteString(strings.Repeat("─", max(10, m.vp.Width)) + "\n\n")
	body := msg.Body
	if body == "" {
		body = msg.Snippet
	}
	b.WriteString(body)
	m.vp.SetContent(b.String())
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
			m.status = fmt.Sprintf("Fetched %d new, classified %d — %s",
				msg.newMail, msg.classified, time.Now().Format("15:04:05"))
		}
		m.reload()
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
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "r":
		if !m.busy {
			m.busy = true
			m.status = "Fetching + classifying…"
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
	case "R": // AI re-categorize the targets
		ids := m.targetIDs()
		if len(ids) > 0 && !m.busy {
			m.busy = true
			m.status = fmt.Sprintf("Re-categorizing %d with AI…", len(ids))
			m.selected = map[int64]bool{}
			return m, m.reclassifyCmd(ids)
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

func (m *model) moveUp() {
	if m.focus == focusSidebar {
		if i := m.nextSelectable(m.catIdx, -1); i != m.catIdx {
			m.catIdx = i
			m.msgIdx = 0
			m.clampMsg()
			m.syncViewport()
		}
		return
	}
	if m.msgIdx > 0 {
		m.msgIdx--
		m.syncViewport()
	}
}

func (m *model) moveDown() {
	if m.focus == focusSidebar {
		if i := m.nextSelectable(m.catIdx, +1); i != m.catIdx {
			m.catIdx = i
			m.msgIdx = 0
			m.clampMsg()
			m.syncViewport()
		}
		return
	}
	if m.msgIdx < len(m.currentMessages())-1 {
		m.msgIdx++
		m.syncViewport()
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
		newMail, classified, err := engine.Refresh(context.Background(), m.st, m.cfg, m.cls)
		return refreshDoneMsg{newMail: newMail, classified: classified, err: err}
	}
}

func (m *model) reclassifyCmd(ids []int64) tea.Cmd {
	return func() tea.Msg {
		n, err := engine.Reclassify(context.Background(), m.st, m.cfg, m.cls, ids)
		return refreshDoneMsg{newMail: 0, classified: n, err: err}
	}
}

// layout sizes the panes to the terminal.
func (m *model) layout() {
	bodyHeight := m.height - 4 // header + footer + borders padding
	if bodyHeight < 3 {
		bodyHeight = 3
	}
	// Split the width left of the sidebar between the list and reading panes so
	// the three panes plus their borders exactly fill the terminal (no overflow,
	// which would wrap the body and cascade the layout). The list prefers
	// listWidth but yields space so the reading pane keeps a usable minimum.
	const readMin = 24
	avail := m.width - sidebarWidth - paneBorders
	if avail < 0 {
		avail = 0
	}
	lw := listWidth
	if lw > avail-readMin { // yield space so the reading pane keeps readMin
		lw = avail - readMin
	}
	if lw < 16 {
		lw = 16
	}
	if lw > avail { // never exceed the available width (keeps rw >= 0)
		lw = avail
	}
	// rw takes the exact remainder, so sidebar+list+reading+borders == width and
	// the body never overflows (which would wrap and cascade the layout).
	rw := avail - lw
	m.listW, m.readW = lw, rw

	if !m.ready {
		m.vp = viewport.New(rw, bodyHeight)
	} else {
		m.vp.Width = rw
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

	sidebar := m.renderSidebar(bodyHeight)
	list := m.renderList(m.listW, bodyHeight)
	reading := m.renderReading(bodyHeight)

	sb := pane(m.focus == focusSidebar).Width(sidebarWidth).Height(bodyHeight).Render(sidebar)
	ls := pane(m.focus == focusList).Width(m.listW).Height(bodyHeight).Render(list)
	rd := paneStyle.Height(bodyHeight).Render(reading)

	body := lipgloss.JoinHorizontal(lipgloss.Top, sb, ls, rd)

	sel := ""
	if len(m.selected) > 0 {
		sel = fmt.Sprintf(" · %d selected", len(m.selected))
	}
	hint := "r refresh · space select · R re-categorize · m move · A make rule · v html · p approve · tab pane · q quit" + sel
	footer := footerStyle.Render(truncPlain(hint, m.width))
	return header + "\n" + body + "\n" + footer
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
	var lines []string
	for i, msg := range msgs {
		from := oneLine(msg.FromName)
		if from == "" {
			from = oneLine(msg.FromAddr)
		}
		subj := oneLine(msg.Subject)
		if subj == "" {
			subj = "(no subject)"
		}
		mark := "  "
		if m.selected[msg.ID] {
			mark = "● "
		}
		// Build the whole row as one plain string, then clamp to exactly w cells
		// (width-aware) and style it across the full width. Doing the mark inside
		// the single fit guarantees the row can never exceed the pane and wrap.
		row := fit(mark+fit(from, 12)+" "+subj, w)
		switch {
		case i == m.msgIdx:
			row = selectedStyle.Render(row)
		case m.selected[msg.ID]:
			row = markStyle.Render(row)
		case !msg.Seen:
			row = unseenStyle.Render(row)
		}
		lines = append(lines, row)
	}
	return clipAround(lines, m.msgIdx, h)
}

func (m *model) renderReading(h int) string {
	return m.vp.View()
}

// --- small helpers ---

// fit truncates s to exactly w display cells (not runes) and right-pads with
// spaces. Display-width aware via runewidth, so emoji and CJK in subjects — each
// 1 rune but 2 cells — can never overflow the pane and wrap the layout.
func fit(s string, w int) string {
	if w <= 0 {
		return ""
	}
	s = runewidth.Truncate(s, w, "…")
	return runewidth.FillRight(s, w)
}

func clip(lines []string, h int) string {
	if len(lines) > h {
		lines = lines[:h]
	}
	return strings.Join(lines, "\n")
}

// clipAround keeps index visible within an h-line window.
func clipAround(lines []string, index, h int) string {
	if len(lines) <= h {
		return strings.Join(lines, "\n")
	}
	start := index - h/2
	if start < 0 {
		start = 0
	}
	if start+h > len(lines) {
		start = len(lines) - h
	}
	return strings.Join(lines[start:start+h], "\n")
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// oneLine flattens a string to a single line by turning newlines, carriage
// returns and tabs into spaces — email subjects/names sometimes contain these,
// and an embedded newline would break the fixed-height list layout.
func oneLine(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		return r
	}, s)
}

// truncPlain truncates an unstyled string to w display cells with an ellipsis
// (no padding). Inputs must not contain ANSI escapes.
func truncPlain(s string, w int) string {
	if w <= 0 {
		return ""
	}
	return runewidth.Truncate(s, w, "…")
}
