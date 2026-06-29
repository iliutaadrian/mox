// Package engine orchestrates the read-only pipeline: fetch new mail over IMAP,
// classify anything unclassified with the AI, and persist results locally.
// Both the TUI and any future headless mode drive the app through here.
package engine

import (
	"context"

	"github.com/iliutaadrian/spark-cli/internal/ai"
	"github.com/iliutaadrian/spark-cli/internal/config"
	"github.com/iliutaadrian/spark-cli/internal/mail"
	"github.com/iliutaadrian/spark-cli/internal/store"
)

// Categories returns the effective fixed set: configured categories plus any
// the user promoted from AI suggestions.
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

// Sync fetches new mail for every account. Returns the count of new messages.
func Sync(st *store.Store, cfg *config.Config) (int, error) {
	total := 0
	for _, acc := range cfg.Accounts {
		n, err := mail.Sync(st, acc, cfg.FetchLimit, cfg.FetchSinceDays)
		if err != nil {
			return total, err
		}
		total += n
	}
	return total, nil
}

// Classify runs the AI over every unclassified message in batches and stores
// the local-only results. Returns the number of messages classified.
func Classify(ctx context.Context, st *store.Store, cfg *config.Config, cls *ai.Classifier) (int, error) {
	cats, err := Categories(st, cfg)
	if err != nil {
		return 0, err
	}
	allowed := make(map[string]bool, len(cats))
	for _, c := range cats {
		allowed[c.Name] = true
	}

	classified := 0
	for {
		batch, err := st.Unclassified(ai.MaxBatch)
		if err != nil {
			return classified, err
		}
		if len(batch) == 0 {
			break
		}

		// Deterministic sender rules run first and never reach the AI. Anything
		// a rule doesn't claim falls through to the AI batch.
		var aiBatch []store.Message
		for _, m := range batch {
			if name := cfg.MatchCategory(m.FromAddr); name != "" {
				if err := st.SetClassification(m.ID, name, "high", "", store.SourceRule); err != nil {
					return classified, err
				}
				classified++
				continue
			}
			aiBatch = append(aiBatch, m)
		}
		// Whole batch was claimed by rules — the loop will fetch the next batch.
		if len(aiBatch) == 0 {
			continue
		}

		results, err := cls.Classify(ctx, cats, aiBatch)
		if err != nil {
			return classified, err
		}
		for _, r := range results {
			if r.Index < 0 || r.Index >= len(aiBatch) {
				continue
			}
			m := aiBatch[r.Index]
			category, confidence, suggested := resolve(r, allowed)
			if err := st.SetClassification(m.ID, category, confidence, suggested, store.SourceAI); err != nil {
				return classified, err
			}
			classified++
		}
		// Guard against a response that classified nothing in the AI batch,
		// which would otherwise loop forever on the same rows.
		if len(results) == 0 {
			break
		}
	}
	return classified, nil
}

// Reclassify clears the given messages and runs classification again over all
// unclassified mail (rules first, then AI). Used for the "re-categorize"
// action on selected messages. Returns the number (re)classified.
func Reclassify(ctx context.Context, st *store.Store, cfg *config.Config, cls *ai.Classifier, ids []int64) (int, error) {
	if err := st.ClearCategory(ids); err != nil {
		return 0, err
	}
	return Classify(ctx, st, cfg, cls)
}

// ApplyRules re-homes every message whose sender now matches a config rule into
// that rule's category (source=rule), overriding any prior AI/manual category.
// No AI is involved. Used after a new sender rule is created so existing mail
// from that sender moves immediately. Returns how many messages changed.
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

// resolve maps a raw AI result to stored fields, handling suggestions and any
// off-enum category the model might return.
func resolve(r ai.Result, allowed map[string]bool) (category, confidence, suggested string) {
	confidence = r.Confidence
	if r.SuggestedNew != "" {
		return store.SuggestedPseudoCategory, confidence, r.SuggestedNew
	}
	if allowed[r.Category] {
		return r.Category, confidence, ""
	}
	// Model returned a category outside the fixed set without flagging it —
	// treat it as a suggestion pending approval rather than trusting it.
	if r.Category != "" {
		return store.SuggestedPseudoCategory, confidence, r.Category
	}
	return store.Uncategorized, confidence, ""
}

// Refresh syncs then classifies. Returns counts for a status line.
func Refresh(ctx context.Context, st *store.Store, cfg *config.Config, cls *ai.Classifier) (newMail, classified int, err error) {
	newMail, err = Sync(st, cfg)
	if err != nil {
		return newMail, 0, err
	}
	classified, err = Classify(ctx, st, cfg, cls)
	return newMail, classified, err
}
