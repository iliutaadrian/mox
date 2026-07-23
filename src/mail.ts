// IMAP layer (imapflow + mailparser). Ported from the former Go internal/mail.
// Strictly read-only except setSeen (the one operation that writes \Seen to the
// server). Sync is UID-incremental. Ported behaviors: RFC 2971 ID (Yahoo drops
// the connection otherwise), UIDVALIDITY reset, date-windowed vs count-based
// backfill, special-use folder detection, attachment metadata only.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import type { Account } from "./config.ts";
import {
  Store,
  CLASS_INBOX,
  CLASS_SENT,
  CLASS_SPAM,
  CLASS_ARCHIVE,
  CLASS_TRASH,
  type Attachment,
  type NewMessage,
} from "./db.ts";

const FETCH_CHUNK = 200;

// Metadata sweep: fetch this many messages per FETCH command. A single FETCH
// over the whole inbox (tens of thousands) is fragile — Yahoo drops long-running
// commands mid-stream — so the sweep is chunked and each chunk is retried on a
// dropped connection. 500 keeps round-trips low (~60 for 30k) while bounding the
// blast radius of a drop to one chunk.
const SWEEP_CHUNK = 500;
const SWEEP_RETRIES = 5;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Folder = { class: string; name: string };

function connect(acc: Account): ImapFlow {
  const c = new ImapFlow({
    host: acc.imapHost,
    port: acc.imapPort,
    secure: true,
    auth: { user: acc.imapUser, pass: acc.imapPass },
    clientInfo: { name: "mox", version: "1.0" },
    logger: false,
    // Keep idle pooled connections alive; if the server still drops one, the
    // 'error'/'close' handlers below evict it and the next use reconnects.
    socketTimeout: 15 * 60 * 1000,
  });
  // imapflow is an EventEmitter: an unhandled 'error' (e.g. "Socket timeout" on
  // an idle pooled connection) would crash the process. Swallow it and evict
  // the dead client from the pool so getClient() reconnects on next use.
  const evict = () => {
    for (const [name, client] of pool) if (client === c) pool.delete(name);
  };
  c.on("error", evict);
  c.on("close", evict);
  return c;
}

// Connection pool: logging in to IMAP (TLS + AUTH + ID) is the dominant cost of
// a refresh (~2-4s/account on Yahoo). Keeping one connection alive per account
// across refreshes turns every refresh after the first into just a SELECT +
// UID-search. The TUI pre-warms these at startup so the first `r` is fast too.
const pool = new Map<string, ImapFlow>();

async function getClient(acc: Account): Promise<ImapFlow> {
  const existing = pool.get(acc.name);
  if (existing && existing.usable) return existing;
  if (existing) {
    try {
      await existing.logout();
    } catch {}
    pool.delete(acc.name);
  }
  const c = connect(acc);
  await c.connect();
  pool.set(acc.name, c);
  return c;
}

// Drop an account's pooled connection so the next getClient() reconnects clean —
// used after a dropped/aborted command mid-sweep.
function dropClient(acc: Account) {
  const c = pool.get(acc.name);
  if (c) {
    pool.delete(acc.name);
    c.logout().catch(() => {});
  }
}

/** Pre-open connections in the background (fire-and-forget) so the first
 * refresh doesn't pay the login cost interactively. */
export function warmConnections(accounts: Account[]) {
  for (const acc of accounts) getClient(acc).catch(() => {});
}

/** Close all pooled connections (call on exit; optional). */
export async function closeConnections() {
  await Promise.all([...pool.values()].map((c) => c.logout().catch(() => {})));
  pool.clear();
}

/** DetectFolders maps Sent/Spam/Archive to their real names via special-use,
 * falling back to name heuristics. INBOX is always first. */
export async function detectFolders(acc: Account): Promise<Folder[]> {
  const client = connect(acc);
  await client.connect();
  try {
    return foldersFromBoxes(await client.list(), acc);
  } finally {
    await client.logout();
  }
}

function snippet(text: string, n: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, n);
}

// Parse a raw RFC822 message into the fields we store (attachment bytes are
// discarded — metadata only).
async function parseRaw(raw: Buffer): Promise<{ text: string; html: string; atts: Attachment[] }> {
  const p = await simpleParser(raw);
  const atts: Attachment[] = (p.attachments ?? [])
    .filter((a) => a.filename || a.contentType !== "application/octet-stream")
    .map((a) => ({ name: a.filename ?? a.contentType, type: a.contentType, size: a.size ?? a.content?.length ?? 0 }));
  return { text: p.text ?? "", html: typeof p.html === "string" ? p.html : "", atts };
}

// A BODYSTRUCTURE node (imapflow's parsed MessageStructureObject). Recursive.
type StructNode = {
  type?: string;
  parameters?: { name?: string };
  size?: number;
  disposition?: string;
  dispositionParameters?: { filename?: string };
  childNodes?: StructNode[];
};

// Derive attachment metadata (name/type/size) from a BODYSTRUCTURE tree — no
// message bytes are downloaded. A leaf is an attachment when it declares
// disposition=attachment or carries a filename/name parameter. Applies the same
// filter as parseRaw (drop nameless application/octet-stream noise) so the two
// fetch paths agree. Returns [] for a message with no real attachments.
function attsFromStructure(node: StructNode | undefined): Attachment[] {
  const out: Attachment[] = [];
  const walk = (n: StructNode | undefined) => {
    if (!n) return;
    if (n.childNodes?.length) {
      for (const c of n.childNodes) walk(c);
      return;
    }
    const name = n.dispositionParameters?.filename || n.parameters?.name || "";
    const isAttachment = (n.disposition ?? "").toLowerCase() === "attachment" || name !== "";
    const type = n.type ?? "application/octet-stream";
    if (!isAttachment) return;
    if (!name && type === "application/octet-stream") return;
    out.push({ name: name || type, type, size: n.size ?? 0 });
  };
  walk(node);
  return out;
}

// Parse one fetched message into a row to insert. Attachment metadata comes
// from BODYSTRUCTURE (present in both the full and envelope-only fetch paths, no
// bytes downloaded), so every synced row records its attachments. Body/html are
// filled only when the raw source was fetched (the recent full-content slice).
async function buildMessage(
  acc: Account,
  cls: string,
  msg: { uid: number; source?: Buffer; envelope?: any; flags?: Set<string>; bodyStructure?: StructNode },
): Promise<NewMessage> {
  const env = msg.envelope ?? {};
  const from = env.from?.[0];
  let text = "",
    html = "";
  const atts: Attachment[] = attsFromStructure(msg.bodyStructure);
  if (msg.source) {
    const parsed = await parseRaw(msg.source);
    text = parsed.text;
    html = parsed.html;
  }
  return {
    account: acc.name,
    mailbox: cls,
    uid: msg.uid,
    messageId: env.messageId ?? "",
    fromAddr: from?.address ?? "",
    fromName: from?.name ?? "",
    subject: env.subject ?? "",
    date: env.date ? Math.floor(new Date(env.date).getTime() / 1000) : Math.floor(Date.now() / 1000),
    snippet: snippet(text, 200),
    body: text,
    html,
    attachments: atts,
    seen: msg.flags?.has("\\Seen") ?? false,
  };
}

const FETCH_OPTS = { uid: true, envelope: true, flags: true, bodyStructure: true, source: true } as const;
// Metadata-only: envelope + flags + BODYSTRUCTURE (attachment metadata, no
// bytes), no raw source. Used for the cold INBOX backfill of everything past the
// full-content window — the whole mailbox stays searchable offline, with
// attachment indicators, while only the recent slice carries body/html.
const FETCH_META = { uid: true, envelope: true, flags: true, bodyStructure: true } as const;

// Rows are inserted in batches of this many (one transaction per batch) so a
// large sweep commits ~hundreds of times, not once per row.
const INSERT_BATCH = 500;

// Live sync progress. `done` counts messages processed from the server (not just
// newly inserted), so the bar advances even on a re-run where most rows already
// exist. phase: "full" = recent body slice, "sweep" = whole-inbox metadata,
// "new" = forward-only arrivals.
export type SyncEvent = { account: string; folder: string; phase: "full" | "sweep" | "new" | "done" | "failed"; done: number; total: number };
export type SyncProgress = (ev: SyncEvent) => void;

// Fetch a set of UIDs (chunked so the UID list per FETCH command stays bounded)
// and insert new rows in batched transactions. `report(done,total)` fires per
// batch with messages processed so far. Returns [inserted, maxUid].
async function fetchInsert(
  client: ImapFlow,
  store: Store,
  acc: Account,
  cls: string,
  uids: number[],
  report?: (done: number, total: number) => void,
): Promise<[number, number]> {
  let inserted = 0;
  let maxUid = 0;
  let processed = 0;
  let batch: NewMessage[] = [];
  const flush = () => {
    if (batch.length) {
      inserted += store.insertMany(batch);
      batch = [];
      report?.(processed, uids.length);
    }
  };
  for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
    const chunk = uids.slice(i, i + FETCH_CHUNK);
    for await (const msg of client.fetch(chunk, FETCH_OPTS, { uid: true })) {
      if (msg.uid > maxUid) maxUid = msg.uid;
      processed++;
      batch.push(await buildMessage(acc, cls, msg as any));
      if (batch.length >= INSERT_BATCH) flush();
    }
  }
  flush();
  return [inserted, maxUid];
}

// Envelope-only sweep over a sequence-number range [start,end]. Inserts metadata
// rows (no body/html); their bodies are fetched on demand when opened, or cached
// later if they fall into an offline category. `report(done,total)` fires per
// batch. Returns [inserted, maxUid].
//
// Chunked with per-chunk reconnect+retry: Yahoo drops long-running FETCH
// commands, so a single stream over the whole inbox would abort partway. Each
// SWEEP_CHUNK-sized command is retried on a dropped connection; a chunk that
// still fails after SWEEP_RETRIES throws so the caller knows the sweep is
// incomplete (it must not be reported as done). Already-inserted rows are kept —
// a re-run resumes from where it stopped because the held count has grown.
async function fetchMetaRange(
  store: Store,
  acc: Account,
  cls: string,
  imapName: string,
  start: number,
  end: number,
  report?: (done: number, total: number) => void,
): Promise<[number, number]> {
  let inserted = 0;
  let maxUid = 0;
  let processed = 0;
  const total = end - start + 1;

  let client = await getClient(acc);
  await client.mailboxOpen(imapName, { readOnly: true });

  for (let lo = start; lo <= end; lo += SWEEP_CHUNK) {
    const hi = Math.min(lo + SWEEP_CHUNK - 1, end);
    for (let attempt = 0; ; attempt++) {
      const batch: NewMessage[] = [];
      try {
        for await (const msg of client.fetch(`${lo}:${hi}`, FETCH_META)) {
          if (msg.uid > maxUid) maxUid = msg.uid;
          batch.push(await buildMessage(acc, cls, msg as any));
        }
        inserted += store.insertMany(batch);
        processed += hi - lo + 1;
        report?.(Math.min(processed, total), total);
        break; // chunk done
      } catch (e) {
        // Connection likely dropped (Yahoo cuts long sessions). Discard the
        // partial batch (re-fetching re-inserts safely — ON CONFLICT dedups),
        // reconnect, and retry this chunk. Give up only after SWEEP_RETRIES.
        if (attempt + 1 >= SWEEP_RETRIES) throw e;
        dropClient(acc);
        await sleep(500 * (attempt + 1));
        client = await getClient(acc);
        await client.mailboxOpen(imapName, { readOnly: true });
      }
    }
  }
  return [inserted, maxUid];
}

// foldersFromBoxes maps a LIST result to normalized folder classes.
function foldersFromBoxes(boxes: any[], acc: Account): Folder[] {
  const byClass: Record<string, string> = {};
  const set = (cls: string, name: string) => {
    if (!byClass[cls]) byClass[cls] = name;
  };
  for (const b of boxes) {
    if (b.specialUse === "\\Sent") set(CLASS_SENT, b.path);
    else if (b.specialUse === "\\Junk") set(CLASS_SPAM, b.path);
    else if (b.specialUse === "\\Archive") set(CLASS_ARCHIVE, b.path);
    else if (b.specialUse === "\\Trash") set(CLASS_TRASH, b.path);
  }
  for (const b of boxes) {
    const l = b.path.toLowerCase();
    if (l.includes("sent")) set(CLASS_SENT, b.path);
    else if (l === "bulk" || l.includes("spam") || l.includes("junk")) set(CLASS_SPAM, b.path);
    else if (l.includes("archive")) set(CLASS_ARCHIVE, b.path);
    else if (l.includes("trash") || l.includes("deleted")) set(CLASS_TRASH, b.path);
  }
  const folders: Folder[] = [{ class: CLASS_INBOX, name: acc.mailbox }];
  for (const cls of [CLASS_SENT, CLASS_SPAM, CLASS_ARCHIVE, CLASS_TRASH]) {
    if (byClass[cls]) folders.push({ class: cls, name: byClass[cls]! });
  }
  return folders;
}

// syncOne syncs one folder on an ALREADY-OPEN client. Once a folder has been
// seeded (lastUid > 0), refreshes are forward-only (a cheap UID search for new
// arrivals) — the expensive full-window backfill runs only on the first sync.
async function syncOne(
  client: ImapFlow,
  store: Store,
  acc: Account,
  imapName: string,
  cls: string,
  fetchLimit: number,
  fetchSinceDays: number,
  prefill: boolean,
  onProgress?: SyncProgress,
): Promise<number> {
  const report = (phase: SyncEvent["phase"]) => (done: number, total: number) =>
    onProgress?.({ account: acc.name, folder: cls, phase, done, total });
  const mbox = await client.mailboxOpen(imapName, { readOnly: true });
  const uidValidity = Number(mbox.uidValidity);
  const exists = mbox.exists;

  let { uidValidity: storedValidity, lastUid } = store.syncState(acc.name, cls);
  if (storedValidity !== 0 && storedValidity !== uidValidity) {
    store.resetMailbox(acc.name, cls);
    lastUid = 0;
  }

  let inserted = 0;
  let maxUid = lastUid;

  if (lastUid > 0) {
    // Warm: forward-only. Fetch all new arrivals above the highest UID we hold.
    // Normally a handful per refresh; after a long offline stretch it catches
    // up the whole backlog in one background pass (the UI never blocks on it).
    const fresh = (await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || [];
    const truly = fresh.filter((u) => u > lastUid);
    if (truly.length) {
      const [n, mx] = await fetchInsert(client, store, acc, cls, truly, report("new"));
      inserted += n;
      if (mx > maxUid) maxUid = mx;
    }
  } else if (fetchSinceDays > 0) {
    // Cold backfill: everything in the window we don't already have.
    const since = new Date(Date.now() - fetchSinceDays * 86400_000);
    const found = (await client.search({ since }, { uid: true })) || [];
    const have = store.storedUIDs(acc.name, cls);
    const missing = found.filter((u) => !have.has(u));
    const [n, mx] = await fetchInsert(client, store, acc, cls, missing, report("full"));
    inserted += n;
    if (mx > maxUid) maxUid = mx;
  } else {
    // Cold backfill, count-based: pull the most-recent `fetchLimit` messages
    // with FULL content (body/html + attachment metadata).
    while (true) {
      const held = store.countMessages(acc.name, cls);
      if (held >= fetchLimit || held >= exists) break;
      const want = Math.min(fetchLimit - held, FETCH_CHUNK);
      const topOlder = exists - held;
      const start = Math.max(1, topOlder - want + 1);
      const uids: number[] = [];
      for await (const msg of client.fetch(`${start}:${topOlder}`, { uid: true })) uids.push(msg.uid);
      if (!uids.length) break;
      const [n, mx] = await fetchInsert(client, store, acc, cls, uids, report("full"));
      inserted += n;
      if (mx > maxUid) maxUid = mx;
      if (n === 0) break;
    }
    // Prefill mode, INBOX only: sweep envelope-only metadata over everything
    // OLDER than the full-content window, so the whole mailbox is searchable
    // offline (bodies fetched on demand, or cached for offline categories). The
    // recent full slice is seq (exists-held+1..exists); the remainder is seq
    // 1..olderTop. maxUid is unchanged — these are older (lower) UIDs, so
    // forward-only refresh still resumes from the newest message.
    if (prefill && cls === CLASS_INBOX) {
      const held = store.countMessages(acc.name, cls);
      const olderTop = exists - held;
      if (olderTop > 0) {
        const [n] = await fetchMetaRange(store, acc, cls, imapName, 1, olderTop, report("sweep"));
        inserted += n;
      }
    }
  }

  // NOTE: no deletion-reconcile here. `SEARCH ALL` is unreliable for this —
  // Yahoo caps SEARCH results (~1000) even for a 5k+ mailbox, so every UID past
  // the cap looks "gone" and got mass-deleted (repeatedly, once auto-refresh
  // ran it every 10s). Leaving a stale local row when mail is deleted on the
  // server is harmless; wiping the local corpus is not. Deletions are handled
  // explicitly by the trash/archive actions instead.

  store.setSyncState(acc.name, cls, uidValidity, maxUid);
  return inserted;
}

/** syncAll syncs one account over a SINGLE connection (one login, not one per
 * folder). With inboxOnly, only the INBOX is touched — fast enough for the
 * interactive `r` refresh; folders (Sent/Spam/Archive) change rarely and are
 * synced by the headless `cli sync`. */
export async function syncAll(
  store: Store,
  acc: Account,
  fetchLimit: number,
  fetchSinceDays: number,
  inboxOnly = false,
  prefill = false,
  onProgress?: SyncProgress,
): Promise<number> {
  // Pooled, kept-alive connection — no logout (see getClient).
  const client = await getClient(acc);
  try {
    if (inboxOnly) {
      return await syncOne(client, store, acc, acc.mailbox, CLASS_INBOX, fetchLimit, fetchSinceDays, prefill, onProgress);
    }
    const folders = foldersFromBoxes(await client.list(), acc);
    let total = 0;
    for (const f of folders) {
      // Re-acquire the pooled client per folder: a mid-sweep reconnect inside
      // syncOne (fetchMetaRange, on a Yahoo drop) evicts and replaces the pooled
      // connection, so the outer `client` reference can go stale between folders.
      const c = await getClient(acc);
      total += await syncOne(c, store, acc, f.name, f.class, fetchLimit, fetchSinceDays, prefill, onProgress);
    }
    return total;
  } catch (e) {
    // Drop a broken connection so the next refresh reconnects cleanly.
    try {
      await client.logout();
    } catch {}
    pool.delete(acc.name);
    throw e;
  }
}

/** reconcileFolders is a cheap removal-only sync for folders we don't fully
 * mirror (Trash/Archive): it lists server UIDs (no message fetch — so Gmail's
 * huge All Mail isn't downloaded) and drops any local row whose UID is gone,
 * keeping local Trash/Archive in step with the server after `r`. */
export async function reconcileFolders(store: Store, acc: Account, classes: string[]): Promise<void> {
  const client = await getClient(acc);
  const folders = foldersFromBoxes(await client.list(), acc).filter((f) => classes.includes(f.class));
  for (const f of folders) {
    // Skip Gmail's "All Mail": it holds every message (nothing is ever "gone"
    // from it) and listing its tens of thousands of UIDs on every refresh is
    // pointlessly slow.
    if (/all mail/i.test(f.name)) continue;
    const mbox = await client.mailboxOpen(f.name, { readOnly: true });
    const serverUids = new Set<number>((await client.search({ all: true }, { uid: true })) || []);
    // SAFETY: `SEARCH ALL` is capped on some servers (Yahoo ~1000), so an
    // incomplete result would make most local rows look "gone". Only trust the
    // result — and thus delete — when it plausibly covers the whole folder
    // (server reports as many messages as SEARCH returned). Otherwise skip;
    // a stale local row is harmless, a mass wipe is not.
    if (serverUids.size < mbox.exists) continue;
    const stored = store.storedUIDs(acc.name, f.class);
    const gone = [...stored].filter((u) => !serverUids.has(u));
    if (gone.length) store.deleteUIDs(acc.name, f.class, gone);
  }
}

/** setSeen sets/clears \Seen on the server for UIDs in one folder (the only
 * server write). */
export async function setSeen(acc: Account, imapName: string, uids: number[], seen: boolean): Promise<void> {
  if (!uids.length) return;
  const client = connect(acc);
  await client.connect();
  try {
    await client.mailboxOpen(imapName, { readOnly: false });
    if (seen) await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
    else await client.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
  } finally {
    await client.logout();
  }
}

// Normalize imapflow's messageMove result into a source-UID -> dest-UID map
// (populated when the server supports UIDPLUS — Yahoo and Gmail do).
function uidMapOf(res: any): Map<number, number> {
  const map = new Map<number, number>();
  if (res && res.uidMap) for (const [src, dst] of res.uidMap) map.set(Number(src), Number(dst));
  return map;
}

/** trashMessages moves UIDs from one folder to the account's Trash folder
 * (server mutation — recoverable from Trash, not a hard delete). Returns the
 * source-UID -> new-Trash-UID map so the local row can follow the message. */
export async function trashMessages(acc: Account, imapName: string, uids: number[]): Promise<Map<number, number>> {
  if (!uids.length) return new Map();
  const client = connect(acc);
  await client.connect();
  try {
    const boxes = await client.list();
    const trash =
      (boxes.find((b: any) => b.specialUse === "\\Trash")?.path as string | undefined) ??
      (boxes.find((b: any) => /trash|deleted/i.test(b.path))?.path as string | undefined);
    if (!trash) throw new Error("no Trash folder found");
    await client.mailboxOpen(imapName, { readOnly: false });
    return uidMapOf(await client.messageMove(uids, trash, { uid: true }));
  } finally {
    await client.logout();
  }
}

/** archiveMessages moves UIDs from a folder to the account's Archive folder
 * (server mutation). Falls back to Gmail's "All Mail" (removing a message from
 * the INBOX there = archived). Returns the source-UID -> new-UID map. */
export async function archiveMessages(acc: Account, imapName: string, uids: number[]): Promise<Map<number, number>> {
  if (!uids.length) return new Map();
  const client = connect(acc);
  await client.connect();
  try {
    const boxes = await client.list();
    const archive =
      (boxes.find((b: any) => b.specialUse === "\\Archive")?.path as string | undefined) ??
      (boxes.find((b: any) => /archive/i.test(b.path))?.path as string | undefined) ??
      (boxes.find((b: any) => b.specialUse === "\\All")?.path as string | undefined) ??
      (boxes.find((b: any) => /all mail/i.test(b.path))?.path as string | undefined);
    if (!archive) throw new Error("no Archive folder found");
    await client.mailboxOpen(imapName, { readOnly: false });
    return uidMapOf(await client.messageMove(uids, archive, { uid: true }));
  } finally {
    await client.logout();
  }
}

/** unarchiveMessages moves UIDs from the account's Archive folder (Gmail: All
 * Mail) back to the INBOX. Returns the source-UID -> new-INBOX-UID map. */
export async function unarchiveMessages(acc: Account, uids: number[]): Promise<Map<number, number>> {
  if (!uids.length) return new Map();
  const client = connect(acc);
  await client.connect();
  try {
    const boxes = await client.list();
    const archive =
      (boxes.find((b: any) => b.specialUse === "\\Archive")?.path as string | undefined) ??
      (boxes.find((b: any) => /archive/i.test(b.path))?.path as string | undefined) ??
      (boxes.find((b: any) => b.specialUse === "\\All")?.path as string | undefined) ??
      (boxes.find((b: any) => /all mail/i.test(b.path))?.path as string | undefined);
    if (!archive) throw new Error("no Archive folder found");
    await client.mailboxOpen(archive, { readOnly: false });
    return uidMapOf(await client.messageMove(uids, acc.mailbox, { uid: true }));
  } finally {
    await client.logout();
  }
}

/** untrashMessages moves UIDs from the account's Trash folder back to the
 * INBOX (server mutation). The restored message reappears in the INBOX on the
 * next sync (with a fresh UID assigned by the server). */
export async function untrashMessages(acc: Account, uids: number[]): Promise<Map<number, number>> {
  if (!uids.length) return new Map();
  const client = connect(acc);
  await client.connect();
  try {
    const boxes = await client.list();
    const trash =
      (boxes.find((b: any) => b.specialUse === "\\Trash")?.path as string | undefined) ??
      (boxes.find((b: any) => /trash|deleted/i.test(b.path))?.path as string | undefined);
    if (!trash) throw new Error("no Trash folder found");
    await client.mailboxOpen(trash, { readOnly: false });
    return uidMapOf(await client.messageMove(uids, acc.mailbox, { uid: true }));
  } finally {
    await client.logout();
  }
}

/** fetchBody re-fetches one message's text+html on demand (for older mail whose
 * body we no longer keep in the local store). Uses the pooled connection. */
export async function fetchBody(acc: Account, imapName: string, uid: number): Promise<{ text: string; html: string }> {
  const client = await getClient(acc);
  await client.mailboxOpen(imapName, { readOnly: true });
  const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
  if (!msg || !msg.source) return { text: "", html: "" };
  const p = await simpleParser(msg.source);
  return { text: p.text ?? "", html: typeof p.html === "string" ? p.html : "" };
}

/** fetchBodies bulk-fetches text+html for many UIDs of ONE folder in a single
 * SELECT + chunked UID FETCH — far fewer round-trips than fetchBody per message,
 * and resilient to per-message parse failures (those UIDs are simply omitted, so
 * the caller can retry them). onEach(done) fires after each message is parsed.
 * Returns a uid -> {text,html} map for the UIDs that came back. */
export async function fetchBodies(
  acc: Account,
  imapName: string,
  uids: number[],
  onEach?: (done: number) => void,
): Promise<Map<number, { text: string; html: string; atts: Attachment[] }>> {
  const out = new Map<number, { text: string; html: string; atts: Attachment[] }>();
  if (!uids.length) return out;
  const client = await getClient(acc);
  await client.mailboxOpen(imapName, { readOnly: true });
  let done = 0;
  for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
    const chunk = uids.slice(i, i + FETCH_CHUNK);
    for await (const msg of client.fetch(chunk, { uid: true, bodyStructure: true, source: true }, { uid: true })) {
      done++;
      onEach?.(done);
      if (!(msg as any).source) continue;
      try {
        const p = await simpleParser((msg as any).source);
        out.set(msg.uid, {
          text: p.text ?? "",
          html: typeof p.html === "string" ? p.html : "",
          atts: attsFromStructure((msg as any).bodyStructure),
        });
      } catch {
        /* unparseable — omit so the caller retries or leaves it metadata-only */
      }
    }
  }
  return out;
}

/** fetchAttachment re-fetches one message's named attachment on demand. */
/** fetchAllAttachments downloads a message once and returns every attachment
 * (real files only; inline images with no filename are skipped). */
export async function fetchAllAttachments(
  acc: Account,
  imapName: string,
  uid: number,
): Promise<{ filename: string; data: Buffer }[]> {
  const client = connect(acc);
  await client.connect();
  try {
    await client.mailboxOpen(imapName, { readOnly: true });
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error(`uid ${uid} not found`);
    const p = await simpleParser(msg.source);
    return (p.attachments ?? [])
      .filter((a) => a.filename)
      .map((a) => ({ filename: a.filename as string, data: a.content as Buffer }));
  } finally {
    await client.logout();
  }
}

export async function fetchAttachment(
  acc: Account,
  imapName: string,
  uid: number,
  name: string,
): Promise<{ data: Buffer; filename: string }> {
  const client = connect(acc);
  await client.connect();
  try {
    await client.mailboxOpen(imapName, { readOnly: true });
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error(`uid ${uid} not found`);
    const p = await simpleParser(msg.source);
    const atts = p.attachments ?? [];
    let hit = name ? atts.find((a) => a.filename === name) : atts.length === 1 ? atts[0] : undefined;
    if (!hit) {
      if (name) throw new Error(`attachment ${name} not found`);
      throw new Error(atts.length === 0 ? "message has no attachments" : "multiple attachments; pass a name");
    }
    return { data: hit.content as Buffer, filename: hit.filename ?? "attachment" };
  } finally {
    await client.logout();
  }
}
