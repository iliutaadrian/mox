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

export type Folder = { class: string; name: string };

function connect(acc: Account): ImapFlow {
  const c = new ImapFlow({
    host: acc.imapHost,
    port: acc.imapPort,
    secure: true,
    auth: { user: acc.imapUser, pass: acc.imapPass },
    clientInfo: { name: "spark-cli", version: "1.0" },
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

async function insertFromFetch(
  store: Store,
  acc: Account,
  cls: string,
  msg: { uid: number; source?: Buffer; envelope?: any; flags?: Set<string> },
): Promise<boolean> {
  const env = msg.envelope ?? {};
  const from = env.from?.[0];
  let text = "",
    html = "",
    atts: Attachment[] = [];
  if (msg.source) {
    const parsed = await parseRaw(msg.source);
    text = parsed.text;
    html = parsed.html;
    atts = parsed.atts;
  }
  const nm: NewMessage = {
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
  return store.insertMessage(nm);
}

const FETCH_OPTS = { uid: true, envelope: true, flags: true, source: true } as const;

// Fetch a set of UIDs and insert new rows. Returns [inserted, maxUid].
async function fetchInsert(client: ImapFlow, store: Store, acc: Account, cls: string, uids: number[]): Promise<[number, number]> {
  let inserted = 0;
  let maxUid = 0;
  for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
    const chunk = uids.slice(i, i + FETCH_CHUNK);
    for await (const msg of client.fetch(chunk, FETCH_OPTS, { uid: true })) {
      if (msg.uid > maxUid) maxUid = msg.uid;
      if (await insertFromFetch(store, acc, cls, msg as any)) inserted++;
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
): Promise<number> {
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
      const [n, mx] = await fetchInsert(client, store, acc, cls, truly);
      inserted += n;
      if (mx > maxUid) maxUid = mx;
    }
  } else if (fetchSinceDays > 0) {
    // Cold backfill: everything in the window we don't already have.
    const since = new Date(Date.now() - fetchSinceDays * 86400_000);
    const found = (await client.search({ since }, { uid: true })) || [];
    const have = store.storedUIDs(acc.name, cls);
    const missing = found.filter((u) => !have.has(u));
    const [n, mx] = await fetchInsert(client, store, acc, cls, missing);
    inserted += n;
    if (mx > maxUid) maxUid = mx;
  } else {
    // Cold backfill, count-based: pull progressively older mail.
    while (true) {
      const held = store.countMessages(acc.name, cls);
      if (held >= fetchLimit || held >= exists) break;
      const want = Math.min(fetchLimit - held, FETCH_CHUNK);
      const topOlder = exists - held;
      const start = Math.max(1, topOlder - want + 1);
      const uids: number[] = [];
      for await (const msg of client.fetch(`${start}:${topOlder}`, { uid: true })) uids.push(msg.uid);
      if (!uids.length) break;
      const [n, mx] = await fetchInsert(client, store, acc, cls, uids);
      inserted += n;
      if (mx > maxUid) maxUid = mx;
      if (n === 0) break;
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
): Promise<number> {
  // Pooled, kept-alive connection — no logout (see getClient).
  const client = await getClient(acc);
  try {
    if (inboxOnly) {
      return await syncOne(client, store, acc, acc.mailbox, CLASS_INBOX, fetchLimit, fetchSinceDays);
    }
    const folders = foldersFromBoxes(await client.list(), acc);
    let total = 0;
    for (const f of folders) {
      total += await syncOne(client, store, acc, f.name, f.class, fetchLimit, fetchSinceDays);
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

/** fetchAttachment re-fetches one message's named attachment on demand. */
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
