// Package engine orchestrates the read-only pipeline: fetch new mail over IMAP
// and file it into categories using deterministic sender rules only. There is
// no AI/LLM classification — anything a rule doesn't claim stays Uncategorized
// (categorize it externally, e.g. via Claude Code). Both the TUI and the
// headless backend drive the app through here.
package engine

import (
	"github.com/iliutaadrian/spark-cli/internal/config"
	"github.com/iliutaadrian/spark-cli/internal/mail"
	"github.com/iliutaadrian/spark-cli/internal/store"
)

// Categories returns the effective fixed set: configured categories plus any
// the user promoted earlier (kept for manual moves).
func Categories(st *store.Store, cfg *config.Config) ([]config.Category, error) {
	cats := make([]config.Category, len(cfg.Categories))
	copy(cats, cfg.Categories)
	approved, err := st.ApprovedCategories()
	if err != nil {
		return nil, err
	}
	for _, name := range approved {
		cats = append(cats, config.Category{Name: name})
	}
	return cats, nil
}

// Sync fetches new mail for every account across INBOX + Sent/Spam/Archive.
// Returns the count of new messages.
func Sync(st *store.Store, cfg *config.Config) (int, error) {
	total := 0
	for _, acc := range cfg.Accounts {
		n, err := mail.SyncAll(st, acc, cfg.FetchLimit, cfg.FetchSinceDays)
		if err != nil {
			return total, err
		}
		total += n
	}
	return total, nil
}

// ClassifyByRules files every currently-unclassified message: a sender-rule
// match sets the rule category, everything else is marked Uncategorized so it
// leaves the unclassified set (no re-loop). Deterministic and fast — no network.
// Returns how many were filed into a real category by a rule.
func ClassifyByRules(st *store.Store, cfg *config.Config) (int, error) {
	filed := 0
	for {
		batch, err := st.Unclassified(500)
		if err != nil {
			return filed, err
		}
		if len(batch) == 0 {
			break
		}
		for _, m := range batch {
			if name := cfg.MatchCategory(m.FromAddr); name != "" {
				if err := st.SetClassification(m.ID, name, "high", "", store.SourceRule); err != nil {
					return filed, err
				}
				filed++
			} else if err := st.SetClassification(m.ID, store.Uncategorized, "", "", ""); err != nil {
				return filed, err
			}
		}
	}
	return filed, nil
}

// ApplyRules re-homes every message whose sender now matches a config rule into
// that rule's category (source=rule), overriding any prior manual category.
// Used after a new sender rule is created so existing mail from that sender
// moves immediately. Returns how many messages changed.
func ApplyRules(st *store.Store, cfg *config.Config) (int, error) {
	all, err := st.All()
	if err != nil {
		return 0, err
	}
	changed := 0
	for _, m := range all {
		name := cfg.MatchCategory(m.FromAddr)
		if name == "" {
			continue
		}
		if m.Category == name && m.Source == store.SourceRule {
			continue // already correct
		}
		if err := st.SetClassification(m.ID, name, "high", "", store.SourceRule); err != nil {
			return changed, err
		}
		changed++
	}
	return changed, nil
}

// Refresh fetches new mail then files it by rules. Returns counts for a status
// line. Fast: IMAP incremental fetch + local rule matching, no AI.
func Refresh(st *store.Store, cfg *config.Config) (newMail, filed int, err error) {
	newMail, err = Sync(st, cfg)
	if err != nil {
		return newMail, 0, err
	}
	filed, err = ClassifyByRules(st, cfg)
	return newMail, filed, err
}
