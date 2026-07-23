// Engine: fetch + deterministic rule-filing. No AI — the first matching config
// rule sets a message's category; anything unmatched in the INBOX becomes
// Uncategorized.
import { Store, UNCATEGORIZED, SOURCE_RULE } from "./db.ts";
import { matchCategory, type Config, type Account } from "./config.ts";
import { syncAll, fetchBody } from "./mail.ts";

/** backfillOffline downloads + caches the full body/html for every message in
 * the configured offline categories that isn't cached yet (offline reading).
 * Categories are INBOX-only, so the body is fetched from each account's INBOX.
 * onProgress(done,total) is called as it goes. Returns how many were fetched. */
export async function backfillOffline(
  store: Store,
  cfg: Config,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  if (cfg.offlineCategories.length === 0) return 0;
  const missing = store.missingBodyInCategories(cfg.offlineCategories);
  const accByName = new Map<string, Account>(cfg.accounts.map((a) => [a.name, a]));
  let done = 0;
  for (const m of missing) {
    const acc = accByName.get(m.account);
    if (acc) {
      try {
        const { text, html } = await fetchBody(acc, acc.mailbox, m.uid);
        if (text || html) store.setContent(m.id, text, html);
      } catch {
        /* skip; next run retries */
      }
    }
    done++;
    onProgress?.(done, missing.length);
  }
  return done;
}

/** classifyByRules files every unclassified INBOX message: the first matching
 * category (by sender address/domain or subject keyword, in config order) wins;
 * anything unmatched becomes Uncategorized. Returns how many a rule claimed. */
export function classifyByRules(store: Store, cfg: Config): number {
  let filed = 0;
  for (;;) {
    const batch = store.unclassified(500);
    if (batch.length === 0) break;
    for (const m of batch) {
      const name = matchCategory(cfg, m.from_addr, m.subject, m.from_name);
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
  // Keep only recent bodies on disk; older mail is fetched on demand when opened.
  if (cfg.contentDays > 0) {
    store.pruneContent(Math.floor(Date.now() / 1000) - cfg.contentDays * 86400, cfg.offlineCategories);
  }
  return { fetched, filed };
}
