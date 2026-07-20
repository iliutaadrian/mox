// Local SQLite store (bun:sqlite). Holds fetched messages + their local-only
// category. Ported from the former Go internal/store. The category lives ONLY
// here — never written back to the mail server. Read AND write (the TUI does
// everything in-process now; there is no separate backend binary).
import { Database } from "bun:sqlite";

export const UNCATEGORIZED = "Uncategorized";
export const SUGGESTED = "Suggested";
export const CLASS_INBOX = "INBOX";
export const CLASS_SENT = "Sent";
export const CLASS_SPAM = "Spam";
export const CLASS_ARCHIVE = "Archive";
export const FOLDER_CLASSES = [CLASS_SENT, CLASS_SPAM, CLASS_ARCHIVE] as const;

export const SOURCE_RULE = "rule";
export const SOURCE_MANUAL = "manual";

export type Attachment = { name: string; type: string; size: number };

export type MessageRow = {
  id: number;
  account: string;
  mailbox: string;
  from_name: string;
  from_addr: string;
  subject: string;
  date: number; // unix seconds
  seen: number;
  category: string;
  suggested_new: string;
};

export type MessageFull = MessageRow & {
  uid: number;
  body: string;
  html: string;
  attachments: string; // JSON array
  source: string;
};

// A message to insert (fetched from IMAP).
export type NewMessage = {
  account: string;
  mailbox: string;
  uid: number;
  messageId: string;
  fromAddr: string;
  fromName: string;
  subject: string;
  date: number; // unix seconds
  snippet: string;
  body: string;
  html: string;
  attachments: Attachment[];
  seen: boolean;
};

export type Filter =
  | { kind: "all" }
  | { kind: "account"; name: string }
  | { kind: "category"; name: string }
  | { kind: "folder"; class: string }
  | { kind: "search"; query: string };

// neomutt-style query. Space-separated terms, AND-ed. Supports field operators
// and quoted phrases:
//   from:alice subject:"invoice 2026" body:refund   (field-scoped)
//   is:unread  is:read                              (seen flag)
//   has:attachment                                  (has a file)
//   in:sent  in:spam  in:archive  in:inbox          (folder class)
//   plain words                                     (subject/sender/body)
// Returns null for an empty query.
function likeArg(s: string): string {
  return `%${s.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
}

function tokenize(q: string): string[] {
  const out: string[] = [];
  const re = /(\w+:)?"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    if (m[2] !== undefined) out.push((m[1] ?? "") + m[2]);
    else out.push(m[3]!);
  }
  return out;
}

export function buildSearch(query: string): { where: string; params: any[] } | null {
  const tokens = tokenize(query.trim());
  if (tokens.length === 0) return null;
  const clauses: string[] = [];
  const params: any[] = [];
  const esc = " ESCAPE '\\'";
  for (const tok of tokens) {
    const ci = tok.indexOf(":");
    const field = ci > 0 ? tok.slice(0, ci).toLowerCase() : "";
    const value = ci > 0 ? tok.slice(ci + 1) : tok;
    switch (field) {
      case "from":
        clauses.push(`(from_addr LIKE ?${esc} OR from_name LIKE ?${esc})`);
        params.push(likeArg(value), likeArg(value));
        break;
      case "subject":
      case "subj":
        clauses.push(`subject LIKE ?${esc}`);
        params.push(likeArg(value));
        break;
      case "body":
        clauses.push(`body LIKE ?${esc}`);
        params.push(likeArg(value));
        break;
      case "is":
        if (value.toLowerCase() === "unread") clauses.push("seen = 0");
        else if (value.toLowerCase() === "read") clauses.push("seen = 1");
        break;
      case "has":
        if (value.toLowerCase().startsWith("attach"))
          clauses.push("(attachments IS NOT NULL AND attachments != '' AND attachments != '[]')");
        break;
      case "in": {
        const map: Record<string, string> = { inbox: "INBOX", sent: "Sent", spam: "Spam", archive: "Archive" };
        const mb = map[value.toLowerCase()];
        if (mb) {
          clauses.push("mailbox = ?");
          params.push(mb);
        }
        break;
      }
      default:
        clauses.push(`(subject LIKE ?${esc} OR from_name LIKE ?${esc} OR from_addr LIKE ?${esc} OR body LIKE ?${esc})`);
        params.push(likeArg(value), likeArg(value), likeArg(value), likeArg(value));
    }
  }
  if (clauses.length === 0) return null;
  return { where: clauses.join(" AND "), params };
}

const LIST_COLS = `id, account, mailbox, COALESCE(from_name,'') AS from_name,
  COALESCE(from_addr,'') AS from_addr, COALESCE(subject,'') AS subject,
  date, seen, COALESCE(category,'') AS category,
  COALESCE(suggested_new,'') AS suggested_new`;

export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL, mailbox TEXT NOT NULL, uid INTEGER NOT NULL,
  message_id TEXT, from_addr TEXT, from_name TEXT, subject TEXT, date INTEGER,
  snippet TEXT, body TEXT, html TEXT, attachments TEXT,
  seen INTEGER NOT NULL DEFAULT 0,
  category TEXT, confidence TEXT, suggested_new TEXT, source TEXT, classified_at INTEGER,
  UNIQUE(account, mailbox, uid)
);
CREATE INDEX IF NOT EXISTS idx_messages_category ON messages(category);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox, date);
CREATE INDEX IF NOT EXISTS idx_messages_acct_mbox ON messages(account, mailbox, date);
CREATE TABLE IF NOT EXISTS sync_state (
  account TEXT NOT NULL, mailbox TEXT NOT NULL,
  uid_validity INTEGER NOT NULL DEFAULT 0, last_uid INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(account, mailbox)
);
CREATE TABLE IF NOT EXISTS approved_categories (
  name TEXT PRIMARY KEY, description TEXT, created_at INTEGER
);`);
  }

  close() {
    this.db.close();
  }

  // ---- reads (TUI) ----

  // The list is capped: the TUI only browses recent mail, and building a
  // 20k-row array on every render is what made startup/scroll feel slow.
  list(f: Filter, limit = 1000): MessageRow[] {
    switch (f.kind) {
      case "all":
        return this.db.query(`SELECT ${LIST_COLS} FROM messages WHERE mailbox='INBOX' ORDER BY date DESC LIMIT ?`).all(limit) as MessageRow[];
      case "account":
        return this.db.query(`SELECT ${LIST_COLS} FROM messages WHERE account=? AND mailbox='INBOX' ORDER BY date DESC LIMIT ?`).all(f.name, limit) as MessageRow[];
      case "folder":
        return this.db.query(`SELECT ${LIST_COLS} FROM messages WHERE mailbox=? ORDER BY date DESC LIMIT ?`).all(f.class, limit) as MessageRow[];
      case "category": {
        const where = f.name === UNCATEGORIZED
          ? "(category IS NULL OR category='' OR category='Uncategorized')"
          : "category=?";
        const q = `SELECT ${LIST_COLS} FROM messages WHERE mailbox='INBOX' AND ${where} ORDER BY date DESC LIMIT ?`;
        return (f.name === UNCATEGORIZED ? this.db.query(q).all(limit) : this.db.query(q).all(f.name, limit)) as MessageRow[];
      }
      case "search": {
        const built = buildSearch(f.query);
        if (!built) return [];
        return this.db.query(
          `SELECT ${LIST_COLS} FROM messages WHERE ${built.where} ORDER BY date DESC LIMIT 2000`,
        ).all(...built.params) as MessageRow[];
      }
    }
  }

  full(id: number): MessageFull | null {
    return this.db.query(
      `SELECT ${LIST_COLS}, uid, COALESCE(body,'') AS body, COALESCE(html,'') AS html,
       COALESCE(attachments,'') AS attachments, COALESCE(source,'') AS source
       FROM messages WHERE id=?`,
    ).get(id) as MessageFull | null;
  }

  totalCount(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM messages WHERE mailbox='INBOX'").get() as any).n;
  }

  accountCounts(): Map<string, number> {
    const rows = this.db.query("SELECT account, COUNT(*) AS n FROM messages WHERE mailbox='INBOX' GROUP BY account").all() as { account: string; n: number }[];
    return new Map(rows.map((r) => [r.account, r.n]));
  }

  categoryCounts(): Map<string, number> {
    const rows = this.db.query(
      `SELECT COALESCE(NULLIF(category,''),'Uncategorized') AS c, COUNT(*) AS n
       FROM messages WHERE mailbox='INBOX' GROUP BY c`,
    ).all() as { c: string; n: number }[];
    return new Map(rows.map((r) => [r.c, r.n]));
  }

  folderCounts(): Map<string, number> {
    const rows = this.db.query(
      `SELECT mailbox, COUNT(*) AS n FROM messages WHERE mailbox IN ('Sent','Spam','Archive') GROUP BY mailbox`,
    ).all() as { mailbox: string; n: number }[];
    return new Map(rows.map((r) => [r.mailbox, r.n]));
  }

  approvedCategories(): string[] {
    return (this.db.query("SELECT name FROM approved_categories ORDER BY created_at").all() as { name: string }[]).map((r) => r.name);
  }

  // ---- writes / sync (engine + mail) ----

  /** Insert a fetched message; existing (account,mailbox,uid) left untouched.
   * Returns true if a new row was inserted. */
  insertMessage(m: NewMessage): boolean {
    const atts = m.attachments.length ? JSON.stringify(m.attachments) : "";
    const res = this.db.query(
      `INSERT INTO messages(account,mailbox,uid,message_id,from_addr,from_name,subject,date,snippet,body,html,attachments,seen)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(account,mailbox,uid) DO NOTHING`,
    ).run(m.account, m.mailbox, m.uid, m.messageId, m.fromAddr, m.fromName, m.subject, m.date, m.snippet, m.body, m.html, atts, m.seen ? 1 : 0);
    return res.changes > 0;
  }

  syncState(account: string, mailbox: string): { uidValidity: number; lastUid: number } {
    const row = this.db.query("SELECT uid_validity, last_uid FROM sync_state WHERE account=? AND mailbox=?").get(account, mailbox) as
      | { uid_validity: number; last_uid: number }
      | null;
    return row ? { uidValidity: row.uid_validity, lastUid: row.last_uid } : { uidValidity: 0, lastUid: 0 };
  }

  setSyncState(account: string, mailbox: string, uidValidity: number, lastUid: number) {
    this.db.query(
      `INSERT INTO sync_state(account,mailbox,uid_validity,last_uid) VALUES(?,?,?,?)
       ON CONFLICT(account,mailbox) DO UPDATE SET uid_validity=excluded.uid_validity, last_uid=excluded.last_uid`,
    ).run(account, mailbox, uidValidity, lastUid);
  }

  resetMailbox(account: string, mailbox: string) {
    this.db.query("DELETE FROM messages WHERE account=? AND mailbox=?").run(account, mailbox);
    this.db.query("DELETE FROM sync_state WHERE account=? AND mailbox=?").run(account, mailbox);
  }

  countMessages(account: string, mailbox: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM messages WHERE account=? AND mailbox=?").get(account, mailbox) as any).n;
  }

  storedUIDs(account: string, mailbox: string): Set<number> {
    const rows = this.db.query("SELECT uid FROM messages WHERE account=? AND mailbox=?").all(account, mailbox) as { uid: number }[];
    return new Set(rows.map((r) => r.uid));
  }

  /** INBOX messages with no category yet (folders keep null category). */
  unclassified(limit: number): { id: number; from_addr: string }[] {
    return this.db.query(
      "SELECT id, COALESCE(from_addr,'') AS from_addr FROM messages WHERE category IS NULL AND mailbox='INBOX' ORDER BY date DESC LIMIT ?",
    ).all(limit) as { id: number; from_addr: string }[];
  }

  /** INBOX rows needed to re-home mail when a new sender rule is added. */
  inboxForRules(): { id: number; from_addr: string; category: string; source: string }[] {
    return this.db.query(
      "SELECT id, COALESCE(from_addr,'') AS from_addr, COALESCE(category,'') AS category, COALESCE(source,'') AS source FROM messages WHERE mailbox='INBOX'",
    ).all() as any;
  }

  setClassification(id: number, category: string, source: string) {
    this.db.query("UPDATE messages SET category=?, source=?, classified_at=? WHERE id=?").run(category, source, Math.floor(Date.now() / 1000), id);
  }

  setCategoryManual(ids: number[], category: string) {
    const stmt = this.db.query("UPDATE messages SET category=?, source='manual', classified_at=? WHERE id=?");
    const now = Math.floor(Date.now() / 1000);
    const tx = this.db.transaction(() => ids.forEach((id) => stmt.run(category, now, id)));
    tx();
  }

  /** Local mirror of a server read/unread flag change. */
  setSeenLocal(id: number, seen: boolean) {
    this.db.query("UPDATE messages SET seen=? WHERE id=?").run(seen ? 1 : 0, id);
  }

  /** Rows needed to map ids -> (account, uid) for server mark/attachment ops. */
  byIds(ids: number[]): { id: number; account: string; mailbox: string; uid: number }[] {
    if (!ids.length) return [];
    const q = `SELECT id, account, mailbox, uid FROM messages WHERE id IN (${ids.map(() => "?").join(",")})`;
    return this.db.query(q).all(...ids) as any;
  }
}
