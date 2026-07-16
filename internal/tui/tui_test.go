package tui

import (
	"testing"

	"github.com/charmbracelet/x/ansi"
)

// fit must clamp to an exact DISPLAY width for any content, measured with
// x/ansi — the same measure lipgloss and bubbletea use. go-runewidth disagrees
// with it on VS16 emoji, ZWJ sequences and flag emoji, and a 1-cell
// disagreement wraps the row and desyncs the whole frame (ghost rows).
func TestFitExactDisplayWidth(t *testing.T) {
	cases := []string{
		"plain ascii",
		"café ☕ 50% off 🎉🎉🎉",
		"日本語のメールの件名です",
		"🎉🎉🎉🎉🎉🎉🎉🎉",
		"❤️ VS16 emoji presentation",
		"‼️ double exclamation ▶️ play",
		"🏳️‍🌈 ZWJ sequence",
		"🇷🇴 flag emoji",
		"Informare mentenanță zona SPA – World Class Iași",
		"",
		"x",
	}
	for _, w := range []int{1, 4, 12, 30} {
		for _, s := range cases {
			got := ansi.StringWidth(fit(s, w))
			if got != w {
				t.Errorf("fit(%q, %d) display width = %d, want %d", s, w, got, w)
			}
		}
	}
}

// The three panes plus their borders must never exceed the terminal width;
// overflow makes lipgloss wrap the body and the layout cascades while scrolling.
// For any realistic width they should fill it exactly.
func TestLayoutBudgetFits(t *testing.T) {
	// Two columns now: sidebar + right (list or reading). They plus the two pane
	// borders must fill the width exactly.
	for _, w := range []int{58, 60, 70, 80, 100, 120, 160, 200} {
		m := &model{width: w, height: 30}
		m.layout()
		total := sidebarWidth + m.readW + paneBorders
		if total != w {
			t.Errorf("width %d: sidebar+right+borders = %d, should fill exactly", w, total)
		}
		if m.readW != m.listW {
			t.Errorf("width %d: list and reading widths should match (%d vs %d)", w, m.readW, m.listW)
		}
		if m.readW < 1 {
			t.Errorf("width %d: degenerate right pane width %d", w, m.readW)
		}
	}
}

// Optional-emoji symbols (Emoji=Yes, Emoji_Presentation=No) must be forced to
// explicit emoji presentation so every width authority agrees on 2 cells —
// uniseg counts "✍" as 1 but tmux/utf8proc draws it 2, which wraps the row
// and ghosts the whole frame.
func TestEmojiPresentationNormalization(t *testing.T) {
	cases := map[string]string{
		"Confirmare comandă ✍":  "Confirmare comandă ✍️",
		"already explicit ✍️": "already explicit ✍️",
		"text style ✍︎":     "text style ✍︎",
		"plain ascii":            "plain ascii",
		"• bullets – dashes …":   "• bullets – dashes …", // punctuation untouched
		"── Mailboxes":           "── Mailboxes",          // box drawing untouched
		"⚠ warning ✔ done ✌":     "⚠️ warning ✔️ done ✌️",
	}
	for in, want := range cases {
		if got := emojiPresentation(in); got != want {
			t.Errorf("emojiPresentation(%q) = %q, want %q", in, got, want)
		}
	}
	// After normalization through oneLine, fitting is exact by uniseg measure.
	s := oneLine("Confirmare înregistrare comandă #493456401 ✍")
	if got := ansi.StringWidth(fit(s, 40)); got != 40 {
		t.Errorf("fit(normalized, 40) = %d cells, want 40", got)
	}
}
