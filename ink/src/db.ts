// Read-only data layer over the Go app's sqlite db. All WRITES go through the
// Go binary (-mark/-move/-reclassify/-sync) so there is exactly one writer
// implementation; this module never opens the db writable.
import { Database } from "bun:sqlite";

export type MessageRow = {
  id: number;
  account: string;
  from_name: string;
  from_addr: string;
  subject: string;
  date: number; // unix seconds
  seen: number;
  category: string;
  suggested_new: string;
};

export type MessageFull = MessageRow & {
  body: string;
  html: string;
  attachments: string; // JSON array of {name,type,size}
  source: string;
};

export type Filter =
  | { kind: "all" }
  | { kind: "account"; name: string }
  | { kind: "category"; name: string };

const LIST_COLS = `id, account, COALESCE(from_name,'') AS from_name,
  COALESCE(from_addr,'') AS from_addr, COALESCE(subject,'') AS subject,
  date, seen, COALESCE(category,'') AS category,
  COALESCE(suggested_new,'') AS suggested_new`;

export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { readonly: true });
  }

  /** Messages for one sidebar entry, newest first. Uncategorized == ''. */
  list(f: Filter): MessageRow[] {
    switch (f.kind) {
      case "all":
        return this.db
          .query(`SELECT ${LIST_COLS} FROM messages ORDER BY date DESC`)
          .all() as MessageRow[];
      case "account":
        return this.db
          .query(`SELECT ${LIST_COLS} FROM messages WHERE account = ? ORDER BY date DESC`)
          .all(f.name) as MessageRow[];
      case "category": {
        const where =
          f.name === "Uncategorized"
            ? "category IS NULL OR category = '' OR category = 'Uncategorized'"
            : "category = ?";
        const q = `SELECT ${LIST_COLS} FROM messages WHERE ${where} ORDER BY date DESC`;
        return (f.name === "Uncategorized"
          ? this.db.query(q).all()
          : this.db.query(q).all(f.name)) as MessageRow[];
      }
    }
  }

  full(id: number): MessageFull | null {
    return this.db
      .query(
        `SELECT ${LIST_COLS}, COALESCE(body,'') AS body, COALESCE(html,'') AS html,
         COALESCE(attachments,'') AS attachments, COALESCE(source,'') AS source
         FROM messages WHERE id = ?`,
      )
      .get(id) as MessageFull | null;
  }

  totalCount(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM messages").get() as any).n;
  }

  accountCounts(): Map<string, number> {
    const rows = this.db
      .query("SELECT account, COUNT(*) AS n FROM messages GROUP BY account")
      .all() as { account: string; n: number }[];
    return new Map(rows.map((r) => [r.account, r.n]));
  }

  categoryCounts(): Map<string, number> {
    const rows = this.db
      .query(
        `SELECT COALESCE(NULLIF(category,''),'Uncategorized') AS c, COUNT(*) AS n
         FROM messages GROUP BY c`,
      )
      .all() as { c: string; n: number }[];
    return new Map(rows.map((r) => [r.c, r.n]));
  }

  approvedCategories(): string[] {
    return (
      this.db
        .query("SELECT name FROM approved_categories ORDER BY created_at")
        .all() as { name: string }[]
    ).map((r) => r.name);
  }

  /** Reopen to pick up changes made by the Go backend process. */
  reopen(path: string) {
    this.db.close();
    this.db = new Database(path, { readonly: true });
  }
}
