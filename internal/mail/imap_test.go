package mail

import (
	"strings"
	"testing"
)

func TestHTMLToText(t *testing.T) {
	in := `<html><head><style>.x{color:red}</style></head><body>
		<h1>Hi</h1><p>Hello &amp; welcome</p>
		<script>evil()</script>
		<ul><li>one</li><li>two</li></ul>
		<a href="https://x.com">link</a></body></html>`
	out := htmlToText(in)

	if strings.Contains(out, "evil") || strings.Contains(out, "color:red") {
		t.Errorf("script/style not removed:\n%q", out)
	}
	if !strings.Contains(out, "Hello & welcome") {
		t.Errorf("entity not decoded / text missing:\n%q", out)
	}
	for _, want := range []string{"Hi", "one", "two", "link"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%q", want, out)
		}
	}
	if strings.Contains(out, "<") || strings.Contains(out, ">") {
		t.Errorf("tags leaked into output:\n%q", out)
	}
}
