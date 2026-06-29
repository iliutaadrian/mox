package store

import (
	"path/filepath"
	"testing"
	"time"
)

func TestStoreLifecycle(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	for i := 0; i < 3; i++ {
		ins, err := st.InsertMessage(&Message{
			Account: "Personal", Mailbox: "INBOX", UID: uint32(100 + i),
			Subject: "S", FromAddr: "a@b.com", Date: time.Now(),
		})
		if err != nil {
			t.Fatal(err)
		}
		if !ins {
			t.Fatalf("uid %d: expected insert", 100+i)
		}
	}

	// Duplicate UID must be ignored.
	if ins, _ := st.InsertMessage(&Message{Account: "Personal", Mailbox: "INBOX", UID: 100, Date: time.Now()}); ins {
		t.Fatal("duplicate insert should return false")
	}

	un, err := st.Unclassified(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(un) != 3 {
		t.Fatalf("unclassified = %d, want 3", len(un))
	}

	// Classify: one Work, one suggestion.
	if err := st.SetClassification(un[0].ID, "Work", "high", "", SourceAI); err != nil {
		t.Fatal(err)
	}
	if err := st.SetClassification(un[1].ID, SuggestedPseudoCategory, "medium", "Travel", SourceAI); err != nil {
		t.Fatal(err)
	}

	if un2, _ := st.Unclassified(10); len(un2) != 1 {
		t.Fatalf("still unclassified = %d, want 1", len(un2))
	}

	// Promote the suggestion.
	if err := st.PromoteSuggestion("Travel", ""); err != nil {
		t.Fatal(err)
	}
	approved, _ := st.ApprovedCategories()
	if len(approved) != 1 || approved[0] != "Travel" {
		t.Fatalf("approved = %v, want [Travel]", approved)
	}

	all, _ := st.All()
	groups := map[string]int{}
	for _, m := range all {
		key := m.Category
		if key == "" {
			key = Uncategorized
		}
		groups[key]++
	}
	if groups["Travel"] != 1 {
		t.Fatalf("after promote, Travel = %d, want 1 (groups=%v)", groups["Travel"], groups)
	}
	if groups[SuggestedPseudoCategory] != 0 {
		t.Fatalf("after promote, Suggested should be empty (groups=%v)", groups)
	}
	if groups[Uncategorized] != 1 {
		t.Fatalf("Uncategorized = %d, want 1", groups[Uncategorized])
	}

	// Sync-state round-trip.
	if err := st.SetSyncState("Personal", "INBOX", 42, 102); err != nil {
		t.Fatal(err)
	}
	v, l, _ := st.SyncState("Personal", "INBOX")
	if v != 42 || l != 102 {
		t.Fatalf("syncstate = (%d,%d), want (42,102)", v, l)
	}
}
