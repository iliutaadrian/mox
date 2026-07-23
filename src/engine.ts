// Engine: fetch + deterministic rule-filing. No AI — the first matching config
// rule sets a message's category; anything unmatched in the INBOX becomes
// Uncategorized. New mail is filed automatically on fetch/`r` (classifyByRules,
// unclassified rows only); re-filing existing mail after a rule change is a
// manual step via `mox --reclassify` (reclassifyAll).
import { Store, UNCATEGORIZED, SOURCE_RULE } from "./db.ts";
import { matchCategory, type Config, type Account } from "./config.ts";
import { syncAll, fetchBodies, type SyncProgress } from "./mail.ts";

/** backfillOffline downloads + caches the full body/html for every message in
 * the configured offline categories that isn't cached yet (offline reading).
 * Categories are INBOX-only, so bodies are bulk-fetched from each account's
 * INBOX (chunked UID FETCH — far fewer round-trips than one call per message).
 * A message whose fetch/parse fails is retried once; anything still missing is
 * left metadata-only (fetched on demand when opened). onProgress(done,total) is
 * called as it goes. Returns how many bodies were cached. */
export async function backfillOffline(
  store: Store,
  cfg: Config,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  if (cfg.offlineCategories.length === 0) return 0;
  const accByName = new Map<string, Account>(cfg.accounts.map((a) => [a.name, a]));
  let cached = 0;

  // Up to two passes: the second retries UIDs that failed to fetch/parse the
  // first time (transient IMAP drops during a long run are the common cause).
  for (let pass = 0; pass < 2; pass++) {
    const missing = store.missingBodyInCategories(cfg.offlineCategories);
    if (missing.length === 0) break;

    // Group targets by account so each opens its INBOX once.
    const byAccount = new Map<string, { id: number; uid: number }[]>();
    for (const m of missing) {
      if (!byAccount.has(m.account)) byAccount.set(m.account, []);
      byAccount.get(m.account)!.push({ id: m.id, uid: m.uid });
    }

    const total = missing.length;
    let done = 0;
    let cachedThisPass = 0;
    for (const [name, rows] of byAccount) {
      const acc = accByName.get(name);
      if (!acc) {
        done += rows.length;
        onProgress?.(done, total);
        continue;
      }
      const byUid = new Map(rows.map((r) => [r.uid, r.id]));
      try {
        const bodies = await fetchBodies(acc, acc.mailbox, rows.map((r) => r.uid));
        for (const [uid, { text, html, atts }] of bodies) {
          const id = byUid.get(uid);
          if (id !== undefined && (text || html)) {
            store.setContent(id, text, html, atts);
            cached++;
            cachedThisPass++;
          }
        }
      } catch {
        /* whole-account failure — retried next pass, or left metadata-only */
      }
      done += rows.length;
      onProgress?.(done, total);
    }
    // No progress on a pass means the remainder is unfetchable — stop retrying.
    if (cachedThisPass === 0) break;
  }
  return cached;
}

/** classifyByRules files every UNCLASSIFIED INBOX message (category IS NULL) —
 * i.e. fresh arrivals from a fetch/`r`: the first matching config category (by
 * sender address/domain or subject keyword, in config order) wins; anything
 * unmatched becomes Uncategorized. Already-categorized mail is left untouched,
 * so it never clobbers an existing category — use reclassifyAll for that.
 * Returns how many a rule claimed. */
export function classifyByRules(store: Store, cfg: Config): number {
  let filed = 0;
  for (;;) {
    const batch = store.unclassified(500);
    if (batch.length === 0) break;
    // Compute the filing for the whole batch, then commit it in one transaction.
    const updates = batch.map((m) => {
      const name = matchCategory(cfg, m.from_addr, m.subject, m.from_name);
      if (name) {
        filed++;
        return { id: m.id, category: name, source: SOURCE_RULE };
      }
      return { id: m.id, category: UNCATEGORIZED, source: "" };
    });
    store.setClassificationMany(updates);
  }
  return filed;
}

/** reclassifyAll re-applies the current config rules to EVERY INBOX message
 * except manually-moved mail — the retroactive counterpart to classifyByRules,
 * run via `mox --reclassify` after editing categories in config.yaml. Adding a
 * domain/word files matching mail; removing one drops the now-unmatched mail
 * back to Uncategorized. Only rows whose category actually changes are written.
 * Returns the moves. */
export function reclassifyAll(store: Store, cfg: Config): { filed: number; unfiled: number; scanned: number } {
  const rows = store.reclassifiable();
  let filed = 0;
  let unfiled = 0;
  for (const m of rows) {
    const name = matchCategory(cfg, m.from_addr, m.subject, m.from_name);
    const nextCat = name || UNCATEGORIZED;
    const nextSrc = name ? SOURCE_RULE : "";
    // Treat NULL / '' / 'Uncategorized' as the same "unclassified" state so a
    // no-op doesn't churn classified_at.
    const wasUncat = !m.category || m.category === UNCATEGORIZED;
    const isUncat = nextCat === UNCATEGORIZED;
    if (wasUncat && isUncat) continue;
    if (m.category === nextCat && (m.source ?? "") === nextSrc) continue;
    store.setClassification(m.id, nextCat, nextSrc);
    if (name) filed++;
    else unfiled++;
  }
  return { filed, unfiled, scanned: rows.length };
}

/** refresh fetches new mail across all folders, then files the newly-arrived
 * INBOX mail by rules (classifyByRules touches only unclassified rows, so
 * existing categories are preserved). Editing config rules and re-filing
 * existing mail is a separate manual step (`mox --reclassify`). With prefill,
 * the INBOX cold backfill additionally sweeps envelope-only metadata over the
 * whole mailbox (see syncOne). */
export async function refresh(
  store: Store,
  cfg: Config,
  inboxOnly = false,
  prefill = false,
  onProgress?: SyncProgress,
): Promise<{ fetched: number; filed: number; failed: string[] }> {
  // Accounts sync concurrently (independent connections), so total time is the
  // slowest account, not the sum. inboxOnly keeps the interactive `r` fast. A
  // failing account is recorded (not silently swallowed) so callers never report
  // a partial prefill as complete.
  const results = await Promise.all(
    cfg.accounts.map((acc) =>
      syncAll(store, acc, cfg.fetchLimit, cfg.fetchSinceDays, inboxOnly, prefill, onProgress)
        .then((n) => {
          onProgress?.({ account: acc.name, folder: "", phase: "done", done: n, total: n });
          return { n, failed: false };
        })
        .catch(() => {
          onProgress?.({ account: acc.name, folder: "", phase: "failed", done: 0, total: 0 });
          return { n: 0, failed: true };
        }),
    ),
  );
  const fetched = results.reduce((a, r) => a + r.n, 0);
  const failed = cfg.accounts.filter((_, i) => results[i]!.failed).map((a) => a.name);
  const filed = classifyByRules(store, cfg);
  // Keep only recent bodies on disk; older mail is fetched on demand when opened.
  if (cfg.contentDays > 0) {
    store.pruneContent(Math.floor(Date.now() / 1000) - cfg.contentDays * 86400, cfg.offlineCategories);
  }
  return { fetched, filed, failed };
}

/** prefill runs the wide one-time seed: a full sync with the INBOX metadata
 * sweep enabled (whole inbox searchable offline), then caches full bodies for
 * the offline categories. Heavy — meant to be run once via `mox --prefill`,
 * not on the interactive path. */
export async function prefill(
  store: Store,
  cfg: Config,
  cb?: {
    onSync?: SyncProgress;
    onSynced?: (fetched: number, filed: number) => void;
    onCache?: (done: number, total: number) => void;
  },
): Promise<{ fetched: number; filed: number; cached: number; failed: string[] }> {
  const { fetched, filed, failed } = await refresh(store, cfg, false, true, cb?.onSync);
  cb?.onSynced?.(fetched, filed);
  const cached = await backfillOffline(store, cfg, cb?.onCache);
  return { fetched, filed, cached, failed };
}
