package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMatchCategory(t *testing.T) {
	cfg := &Config{Categories: []Category{
		{Name: "GitHub", Match: &Match{Domains: []string{"github.com"}}},
		{Name: "Honeybadger", Match: &Match{
			Domains:   []string{"honeybadger.io"},
			Addresses: []string{"vip@example.com"},
		}},
		{Name: "Newsletters"}, // AI-only, no rules
	}}

	cases := map[string]string{
		"notifications@github.com":     "GitHub",
		"build@ci.github.com":          "GitHub", // subdomain
		"alerts@honeybadger.io":        "Honeybadger",
		"VIP@example.com":              "Honeybadger", // exact address, case-insensitive
		"someone@gmail.com":            "",            // no rule
		"":                            "",
	}
	for addr, want := range cases {
		if got := cfg.MatchCategory(addr); got != want {
			t.Errorf("MatchCategory(%q) = %q, want %q", addr, got, want)
		}
	}

	if !cfg.Categories[0].HasRules() {
		t.Error("GitHub should HasRules()")
	}
	if cfg.Categories[2].HasRules() {
		t.Error("Newsletters should not HasRules()")
	}
}

func TestAddSenderRulePreservesComments(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	original := `# top comment
model: gpt-4o-mini

accounts:
  - name: Personal
    imap_host: imap.mail.yahoo.com
    imap_user: me@yahoo.com

categories:
  - name: GitHub
    description: GitHub stuff # inline comment
  - name: Other
    description: fallback
`
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	// Add a rule to a category that has no match block yet.
	if err := AddSenderRule(path, "GitHub", []string{"github.com", "GITHUB.COM"}, nil); err != nil {
		t.Fatal(err)
	}
	// Add an address rule to the same category (should extend, not duplicate).
	if err := AddSenderRule(path, "GitHub", []string{"github.com"}, []string{"noreply@github.com"}); err != nil {
		t.Fatal(err)
	}

	out, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)

	if !strings.Contains(s, "# top comment") || !strings.Contains(s, "# inline comment") {
		t.Errorf("comments not preserved:\n%s", s)
	}
	// Reload and confirm the rule resolves and is de-duplicated.
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := cfg.MatchCategory("x@github.com"); got != "GitHub" {
		t.Errorf("after writeback MatchCategory = %q, want GitHub", got)
	}
	var gh Category
	for _, c := range cfg.Categories {
		if c.Name == "GitHub" {
			gh = c
		}
	}
	if len(gh.Match.Domains) != 1 {
		t.Errorf("domains = %v, want exactly 1 (deduped)", gh.Match.Domains)
	}
	if len(gh.Match.Addresses) != 1 {
		t.Errorf("addresses = %v, want 1", gh.Match.Addresses)
	}
}
