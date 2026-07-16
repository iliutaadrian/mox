package tui

// Frame-geometry regression tests. The rendered frame must be EXACTLY the
// terminal size, measured with x/ansi (the same measure bubbletea's renderer
// uses). A frame even one line too tall — e.g. from a list row that wraps
// inside its pane because go-runewidth and uniseg disagree on an emoji's
// width — scrolls the terminal and permanently desyncs the line-diff
// renderer, leaving ghost rows (duplicated sidebar headers, stale cursor
// highlights).

import (
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"

	"github.com/iliutaadrian/spark-cli/internal/config"
	"github.com/iliutaadrian/spark-cli/internal/store"
)

func geometryModel(w, h int) *model {
	cfg := &config.Config{
		Accounts: []config.Account{{Name: "Personal"}, {Name: "Secondary"}, {Name: "Work"}},
	}
	rows := []struct {
		from, cat, subj string
		seen            bool
	}{
		{"Sameday", "Shopping", "Au ajuns la easybox 1/1 colete din comanda 493456401", false},
		{"ING_pentru_Digi@ing.ro", "Finance", "Plata acceptata - comanda 235542561", false},
		{"Interactive Brokers", "Finance", "Daily Activity Statement for 06/29/2026", false},
		{"World Class Romania", "Notifications", "Informare mentenanță zona SPA – World Class Iași", false},
		{"E.ON Myline", "Bills", "Factura ta E.ON a fost emisă", true},
		// The width-disagreement cases: VS16 emoji, ZWJ sequences, flags. Each
		// is 1 cell wider by uniseg than by go-runewidth.
		{"❤️ Newsletter", "Newsletters", "We ❤️ you — ‼️ last chance ▶️ watch now", false},
		// Real repro from the user's mailbox: switching the sidebar to an account
		// whose newest messages carry VS16 emoji ghosted the whole frame.
		{"Freenow", "Travel", "Your summer holiday checklist inside ✈️", false},
		{"Morning Brew", "Newsletters", "☕️ Billionaire battle", false},
		// Optional-emoji symbol (U+270D, uniseg width 1, tmux/utf8proc width 2):
		// the real trigger of the ghost-row bug in the user's mailbox.
		{"eMAG.ro", "Shopping", "Confirmare înregistrare comandă #493456401 ✍", false},
		{"🏳️‍🌈 Pride", "Social", "🇷🇴 Bucharest events this weekend 🏳️‍🌈", false},
		{"日本語テスト", "Notifications", "🎉 50% off café ☕ — ends tonight 🎉🎉", false},
	}
	var msgs []store.Message
	for i, s := range rows {
		msgs = append(msgs, store.Message{
			ID: int64(i + 1), Account: "Personal", FromName: s.from,
			Subject: s.subj, Category: s.cat, Seen: s.seen,
			Date: time.Date(2026, 6, 30, 0, 0, 0, 0, time.UTC),
		})
	}
	m := &model{
		cfg: cfg, msgs: msgs,
		selected: map[int64]bool{1: true, 3: true},
		width:    w, height: h,
		focus:  focusList,
		msgIdx: 2,
	}
	m.groups = map[string][]store.Message{}
	m.byAccount = map[string][]store.Message{}
	for _, msg := range msgs {
		m.groups[msg.Category] = append(m.groups[msg.Category], msg)
		m.byAccount[msg.Account] = append(m.byAccount[msg.Account], msg)
	}
	m.side = []sideEntry{
		{kind: kindAll, name: allBucket},
		{kind: kindHeader, name: "Mailboxes"},
		{kind: kindMailbox, name: "Personal"},
		{kind: kindMailbox, name: "Secondary"},
		{kind: kindMailbox, name: "Work"},
		{kind: kindHeader, name: "Manual"},
		{kind: kindCategory, name: "Finance"},
		{kind: kindCategory, name: "Shopping"},
		{kind: kindCategory, name: "Notifications"},
	}
	m.catIdx = 2 // Personal
	m.layout()
	m.ready = true
	return m
}

func TestViewFrameGeometry(t *testing.T) {
	for _, dim := range [][2]int{{250, 30}, {120, 40}, {80, 24}, {60, 10}, {46, 8}} {
		w, h := dim[0], dim[1]
		m := geometryModel(w, h)
		out := m.View()
		lines := strings.Split(out, "\n")
		if len(lines) != h {
			t.Errorf("%dx%d: frame has %d lines, want exactly %d", w, h, len(lines), h)
		}
		for i, l := range lines {
			if lw := ansi.StringWidth(l); lw > w {
				t.Errorf("%dx%d: line %d is %d cells wide (>%d): %q", w, h, i, lw, w, ansi.Strip(l))
			}
		}
		plain := ansi.Strip(out)
		if c := strings.Count(plain, "All ("); c != 1 {
			t.Errorf("%dx%d: sidebar 'All (' appears %d times, want 1", w, h, c)
		}
		if c := strings.Count(plain, "Mailboxes"); c != 1 {
			t.Errorf("%dx%d: 'Mailboxes' header appears %d times, want 1", w, h, c)
		}
	}
}

// Reading mode must obey the same frame budget (the viewport clamps long body
// lines itself, but the frame around it must still be exact).
func TestViewFrameGeometryReading(t *testing.T) {
	m := geometryModel(120, 30)
	m.mode = modeReading
	m.msgs[2].Body = strings.Repeat("a very long unwrapped body line ❤️ ", 40) + "\n" +
		strings.Repeat("x", 500)
	m.syncViewport()
	out := m.View()
	lines := strings.Split(out, "\n")
	if len(lines) != 30 {
		t.Errorf("reading mode: frame has %d lines, want exactly 30", len(lines))
	}
	for i, l := range lines {
		if lw := ansi.StringWidth(l); lw > 120 {
			t.Errorf("reading mode: line %d is %d cells wide (>120)", i, lw)
		}
	}
}

// Scrolling must stay O(visible rows), not O(messages): with tens of
// thousands of messages in All/mailbox views, per-keystroke rendering of the
// whole list makes scrolling crawl.
func BenchmarkRenderListHuge(b *testing.B) {
	m := geometryModel(225, 26)
	var msgs []store.Message
	for i := 0; i < 20000; i++ {
		msgs = append(msgs, store.Message{
			ID: int64(i + 1), Account: "Personal",
			FromName: "Some Sender Name", Subject: "A fairly typical email subject line #493456401 ✍",
			Category: "Shopping", Seen: i%3 == 0,
			Date: time.Date(2026, 6, 30, 0, 0, 0, 0, time.UTC),
		})
	}
	m.msgs = msgs
	m.byAccount["Personal"] = msgs
	m.catIdx = 2
	m.msgIdx = 10000
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		m.View()
	}
}
