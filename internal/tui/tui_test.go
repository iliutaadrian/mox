package tui

import (
	"testing"

	"github.com/mattn/go-runewidth"
)

// fit must clamp to an exact DISPLAY width for any content — emoji and CJK are
// 1 rune but 2 cells, and a row wider than its pane wraps and cascades the list.
func TestFitExactDisplayWidth(t *testing.T) {
	cases := []string{
		"plain ascii",
		"café ☕ 50% off 🎉🎉🎉",
		"日本語のメールの件名です",
		"🎉🎉🎉🎉🎉🎉🎉🎉",
		"",
		"x",
	}
	for _, w := range []int{1, 4, 12, 30} {
		for _, s := range cases {
			got := runewidth.StringWidth(fit(s, w))
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
			t.Errorf("width %d: list and reading widths should match (%d vs %d)", w, m.listW, m.readW)
		}
		if m.readW < 1 {
			t.Errorf("width %d: degenerate right pane width %d", w, m.readW)
		}
	}
}
