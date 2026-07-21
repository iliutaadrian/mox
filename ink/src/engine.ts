// Engine: fetch + deterministic rule-filing. Ported from the former Go
// internal/engine. No AI — a sender-rule match sets the category, everything
// unmatched in the INBOX becomes Uncategorized.
import { Store, UNCATEGORIZED, SOURCE_RULE } from "./db.ts";
import { matchCategory, type Config } from "./config.ts";
import { syncAll } from "./mail.ts";

/** classifyByRules files every unclassified INBOX message: the first matching
 * category (by sender address/domain or subject keyword, in config order) wins;
 * anything unmatched becomes Uncategorized. Returns how many a rule claimed. */
export function classifyByRules(store: Store, cfg: Config): number {
  let filed = 0;
  for (;;) {
    const batch = store.unclassified(500);
    if (batch.length === 0) break;
    for (const m of batch) {
      const name = matchCategory(cfg, m.from_addr, m.subject);
      if (name) {
        store.setClassification(m.id, name, SOURCE_RULE);
        filed++;
      } else {
        store.setClassification(m.id, UNCATEGORIZED, "");
      }
    }
  }
  return filed;
}

/** applyRules re-homes every INBOX message whose sender now matches a rule.
 * Returns how many changed. Used after a new rule is created. */
export function applyRules(store: Store, cfg: Config): number {
  let changed = 0;
  for (const m of store.inboxForRules()) {
    const name = matchCategory(cfg, m.from_addr, m.subject);
    if (!name) continue;
    if (m.category === name && m.source === SOURCE_RULE) continue;
    store.setClassification(m.id, name, SOURCE_RULE);
    changed++;
  }
  return changed;
}

/** refresh fetches new mail across all folders, then files the INBOX by rules. */
export async function refresh(
  store: Store,
  cfg: Config,
  inboxOnly = false,
): Promise<{ fetched: number; filed: number }> {
  // Accounts sync concurrently (independent connections), so total time is the
  // slowest account, not the sum. inboxOnly keeps the interactive `r` fast.
  const counts = await Promise.all(
    cfg.accounts.map((acc) =>
      syncAll(store, acc, cfg.fetchLimit, cfg.fetchSinceDays, inboxOnly).catch(() => 0),
    ),
  );
  const fetched = counts.reduce((a, b) => a + b, 0);
  const filed = classifyByRules(store, cfg);
  return { fetched, filed };
}
