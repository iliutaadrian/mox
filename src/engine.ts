// Engine: fetch + deterministic rule-filing. No AI — the first matching config
// rule sets a message's category; anything unmatched in the INBOX becomes
// Uncategorized.
import { Store, UNCATEGORIZED, SOURCE_RULE } from "./db.ts";
import { matchCategory, type Config, type Account } from "./config.ts";
import { syncAll, fetchBodies } from "./mail.ts";

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
        for (const [uid, { text, html }] of bodies) {
          const id = byUid.get(uid);
          if (id !== undefined && (text || html)) {
            store.setContent(id, text, html);
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

/** refresh fetches new mail across all folders, then files the INBOX by rules.
 * With prefill, the INBOX cold backfill additionally sweeps envelope-only
 * metadata over the whole mailbox (see syncOne). */
export async function refresh(
  store: Store,
  cfg: Config,
  inboxOnly = false,
  prefill = false,
): Promise<{ fetched: number; filed: number }> {
  // Accounts sync concurrently (independent connections), so total time is the
  // slowest account, not the sum. inboxOnly keeps the interactive `r` fast.
  const counts = await Promise.all(
    cfg.accounts.map((acc) =>
      syncAll(store, acc, cfg.fetchLimit, cfg.fetchSinceDays, inboxOnly, prefill).catch(() => 0),
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

/** prefill runs the wide one-time seed: a full sync with the INBOX metadata
 * sweep enabled (whole inbox searchable offline), then caches full bodies for
 * the offline categories. Heavy — meant to be run once via `mox --prefill`,
 * not on the interactive path. */
export async function prefill(
  store: Store,
  cfg: Config,
  cb?: {
    onSynced?: (fetched: number, filed: number) => void;
    onCache?: (done: number, total: number) => void;
  },
): Promise<{ fetched: number; filed: number; cached: number }> {
  const { fetched, filed } = await refresh(store, cfg, false, true);
  cb?.onSynced?.(fetched, filed);
  const cached = await backfillOffline(store, cfg, cb?.onCache);
  return { fetched, filed, cached };
}
