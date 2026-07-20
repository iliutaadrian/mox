package engine

import (
	"path/filepath"
	"testing"

	"github.com/iliutaadrian/spark-cli/internal/config"
	"github.com/iliutaadrian/spark-cli/internal/store"
)

// ClassifyByRules files rule-matched senders into their category and marks
// everything else Uncategorized, deterministically and with no network.
func TestClassifyByRules(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	for _, addr := range []string{"notifications@github.com", "build@ci.github.com", "stranger@example.com"} {
		if _, err := st.InsertMessage(&store.Message{
			Account: "A", Mailbox: "INBOX", UID: uint32(len(addr)), FromAddr: addr, Subject: "x",
		}); err != nil {
			t.Fatal(err)
		}
	}

	cfg := &config.Config{Categories: []config.Category{
		{Name: "GitHub", Match: &config.Match{Domains: []string{"github.com"}}},
	}}

	filed, err := ClassifyByRules(st, cfg)
	if err != nil {
		t.Fatalf("ClassifyByRules: %v", err)
	}
	if filed != 2 {
		t.Fatalf("filed by rule = %d, want 2", filed)
	}

	all, _ := st.All()
	for _, m := range all {
		if m.FromAddr == "stranger@example.com" {
			if m.Category != store.Uncategorized {
				t.Errorf("stranger: category=%q, want Uncategorized", m.Category)
			}
			continue
		}
		if m.Category != "GitHub" || m.Source != store.SourceRule {
			t.Errorf("msg %s: category=%q source=%q, want GitHub/rule", m.FromAddr, m.Category, m.Source)
		}
	}
	if un, _ := st.Unclassified(10); len(un) != 0 {
		t.Errorf("still unclassified = %d, want 0", len(un))
	}
}

// ApplyRules re-homes already-classified mail when a new rule appears,
// overriding the prior (e.g. AI/manual) category.
func TestApplyRulesRehomes(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	id := insert(t, st, "notifications@github.com")
	other := insert(t, st, "friend@gmail.com")
	// Pretend both were previously filed under Notifications (e.g. manually).
	st.SetClassification(id, "Notifications", "low", "", store.SourceManual)
	st.SetClassification(other, "Notifications", "low", "", store.SourceManual)

	cfg := &config.Config{Categories: []config.Category{
		{Name: "GitHub", Match: &config.Match{Domains: []string{"github.com"}}},
		{Name: "Notifications"},
	}}

	n, err := ApplyRules(st, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("rehomed = %d, want 1", n)
	}
	all, _ := st.All()
	for _, m := range all {
		switch m.FromAddr {
		case "notifications@github.com":
			if m.Category != "GitHub" || m.Source != store.SourceRule {
				t.Errorf("github msg: %q/%q, want GitHub/rule", m.Category, m.Source)
			}
		case "friend@gmail.com":
			if m.Category != "Notifications" { // untouched
				t.Errorf("gmail msg moved unexpectedly to %q", m.Category)
			}
		}
	}
}

func insert(t *testing.T, st *store.Store, addr string) int64 {
	t.Helper()
	if _, err := st.InsertMessage(&store.Message{
		Account: "A", Mailbox: "INBOX", UID: uint32(len(addr)) + uint32(addr[0]), FromAddr: addr, Subject: "s",
	}); err != nil {
		t.Fatal(err)
	}
	all, _ := st.All()
	for _, m := range all {
		if m.FromAddr == addr {
			return m.ID
		}
	}
	t.Fatalf("inserted message %s not found", addr)
	return 0
}
