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
  type Attachment,
  type NewMessage,
} from "./db.ts";

const FETCH_CHUNK = 200;

export type Folder = { class: string; name: string };

function connect(acc: Account): ImapFlow {
  return new ImapFlow({
    host: acc.imapHost,
    port: acc.imapPort,
    secure: true,
    auth: { user: acc.imapUser, pass: acc.imapPass },
    clientInfo: { name: "spark-cli", version: "1.0" },
    logger: false,
  });
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
  }
  for (const b of boxes) {
    const l = b.path.toLowerCase();
    if (l.includes("sent")) set(CLASS_SENT, b.path);
    else if (l === "bulk" || l.includes("spam") || l.includes("junk")) set(CLASS_SPAM, b.path);
    else if (l.includes("archive")) set(CLASS_ARCHIVE, b.path);
  }
  const folders: Folder[] = [{ class: CLASS_INBOX, name: acc.mailbox }];
  for (const cls of [CLASS_SENT, CLASS_SPAM, CLASS_ARCHIVE]) {
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
    // Warm: forward-only. Just new arrivals above the highest UID we hold.
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
