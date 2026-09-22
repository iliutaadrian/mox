// The local store. Categories and the done flag exist ONLY here, so a mistake
// in this layer is invisible on the server and impossible to recover from.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLASS_INBOX, CLASS_TRASH, Store, UNCATEGORIZED, type NewMessage } from "../src/db.ts";

let dir: string;
let store: Store;

const msg = (over: Partial<NewMessage> & { uid: number }): NewMessage => ({
  account: "Test",
  mailbox: CLASS_INBOX,
  messageId: `<${over.uid}@example.com>`,
  fromAddr: "sender@example.com",
  fromName: "Sender",
  subject: `Subject ${over.uid}`,
  date: 1_780_000_000 - over.uid,
  snippet: "",
  body: "",
  html: "",
  attachments: [],
  seen: false,
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mox-db-"));
  store = new Store(join(dir, "test.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("insertMany", () => {
  test("inserts and is idempotent on (account, mailbox, uid)", () => {
    expect(store.insertMany([msg({ uid: 1 }), msg({ uid: 2 })])).toBe(2);
    store.insertMany([msg({ uid: 1 }), msg({ uid: 3 })]);
    expect(store.list({ kind: "all", exclude: [] }, 100).length).toBe(3);
  });
});

describe("full", () => {
  test("exposes message_id for reply threading", () => {
    store.insertMany([msg({ uid: 7, messageId: "<thread-me@server>" })]);
    const row = store.list({ kind: "all", exclude: [] }, 1)[0]!;
    expect(store.full(row.id)!.message_id).toBe("<thread-me@server>");
  });

  test("returns null for an unknown id", () => {
    expect(store.full(999_999)).toBeNull();
  });
});

describe("done is local-only state", () => {
  test("a done message leaves the inbox view but stays in ALL", () => {
    store.insertMany([msg({ uid: 1 }), msg({ uid: 2 })]);
    const first = store.list({ kind: "inbox", exclude: [] }, 10)[0]!;
    store.setDone([first.id], true);
    expect(store.list({ kind: "inbox", exclude: [] }, 10).map((m) => m.id)).not.toContain(first.id);
    expect(store.list({ kind: "all", exclude: [] }, 10).map((m) => m.id)).toContain(first.id);
  });

  test("restoring puts it back", () => {
    store.insertMany([msg({ uid: 1 })]);
    const row = store.list({ kind: "inbox", exclude: [] }, 10)[0]!;
    store.setDone([row.id], true);
    store.setDone([row.id], false);
    expect(store.list({ kind: "inbox", exclude: [] }, 10).length).toBe(1);
  });
});

describe("categories", () => {
  test("a manual move sets the category and marks the source manual", () => {
    store.insertMany([msg({ uid: 1 })]);
    const row = store.list({ kind: "all", exclude: [] }, 1)[0]!;
    store.setCategoryManual([row.id], "Finance");
    const full = store.full(row.id)!;
    expect(full.category).toBe("Finance");
    expect(full.source).toBe("manual");
  });

  test("unclassified only returns rows with no category", () => {
    store.insertMany([msg({ uid: 1 }), msg({ uid: 2 })]);
    expect(store.unclassified(10).length).toBe(2);
    const ids = store.list({ kind: "all", exclude: [] }, 10).map((m) => m.id);
    store.setClassification(ids[0]!, UNCATEGORIZED, "");
    expect(store.unclassified(10).length).toBe(1);
  });

  test("a category filter selects only its own mail", () => {
    store.insertMany([msg({ uid: 1 }), msg({ uid: 2 })]);
    const ids = store.list({ kind: "all", exclude: [] }, 10).map((m) => m.id);
    store.setCategoryManual([ids[0]!], "Bills");
    expect(store.list({ kind: "category", name: "Bills" }, 10).length).toBe(1);
  });
});

describe("search", () => {
  beforeEach(() => {
    store.insertMany([
      msg({ uid: 1, subject: "Invoice 4471", fromAddr: "billing@shop.example", body: "amount due" }),
      msg({ uid: 2, subject: "Weekend plans", fromAddr: "friend@example.org", body: "hiking in the mountains", seen: true }),
      msg({ uid: 3, subject: "Deploy failed", fromAddr: "ci@example.dev", body: "pipeline broke" }),
    ]);
  });

  test("bare words match subject, sender and body", () => {
    expect(store.list({ kind: "search", query: "invoice" }, 10).length).toBe(1);
    expect(store.list({ kind: "search", query: "hiking" }, 10).length).toBe(1);
    expect(store.list({ kind: "search", query: "example" }, 10).length).toBe(3);
  });

  test("from: narrows to the sender", () => {
    expect(store.list({ kind: "search", query: "from:billing" }, 10).length).toBe(1);
  });

  test("subject: narrows to the subject", () => {
    expect(store.list({ kind: "search", query: "subject:deploy" }, 10).length).toBe(1);
    expect(store.list({ kind: "search", query: "subject:pipeline" }, 10).length).toBe(0);
  });

  test("is:unread filters by seen state", () => {
    expect(store.list({ kind: "search", query: "is:unread" }, 10).length).toBe(2);
    expect(store.list({ kind: "search", query: "is:read" }, 10).length).toBe(1);
  });

  test("a quoted phrase matches as a phrase", () => {
    expect(store.list({ kind: "search", query: '"amount due"' }, 10).length).toBe(1);
    expect(store.list({ kind: "search", query: '"due amount"' }, 10).length).toBe(0);
  });

  test("no match yields nothing", () => {
    expect(store.list({ kind: "search", query: "zzzzz" }, 10).length).toBe(0);
  });
});

describe("mailbox moves", () => {
  test("setMailboxUid relabels a row so it follows the server move", () => {
    store.insertMany([msg({ uid: 1 })]);
    const row = store.list({ kind: "all", exclude: [] }, 1)[0]!;
    store.setMailboxUid(row.id, CLASS_TRASH, 555);
    const moved = store.full(row.id)!;
    expect(moved.mailbox).toBe(CLASS_TRASH);
    expect(moved.uid).toBe(555);
    expect(store.list({ kind: "inbox", exclude: [] }, 10).length).toBe(0);
    expect(store.list({ kind: "folder", class: CLASS_TRASH }, 10).length).toBe(1);
  });

  test("deleteByIds removes rows", () => {
    store.insertMany([msg({ uid: 1 }), msg({ uid: 2 })]);
    const ids = store.list({ kind: "all", exclude: [] }, 10).map((m) => m.id);
    store.deleteByIds([ids[0]!]);
    expect(store.list({ kind: "all", exclude: [] }, 10).length).toBe(1);
  });
});

describe("seen state", () => {
  test("setSeenLocal flips the flag", () => {
    store.insertMany([msg({ uid: 1 })]);
    const row = store.list({ kind: "all", exclude: [] }, 1)[0]!;
    store.setSeenLocal(row.id, true);
    expect(store.full(row.id)!.seen).toBe(1);
    store.setSeenLocal(row.id, false);
    expect(store.full(row.id)!.seen).toBe(0);
  });
});

describe("attachments", () => {
  test("has_att is set only when metadata is present", () => {
    store.insertMany([
      msg({ uid: 1, attachments: [{ name: "a.pdf", type: "application/pdf", size: 10 }] }),
      msg({ uid: 2 }),
    ]);
    // list() returns MessageRow, which carries has_att but not uid — match on subject.
    const rows = store.list({ kind: "all", exclude: [] }, 10);
    expect(rows.find((r) => r.subject === "Subject 1")!.has_att).toBe(1);
    expect(rows.find((r) => r.subject === "Subject 2")!.has_att).toBe(0);
  });
});

describe("arrival window", () => {
  // The login-code auto-copy scans exactly what one sync inserted. Re-yielding
  // a message already held must not put it back in the window — otherwise a
  // code could land on the clipboard a second time, over something copied since.
  test("only rows inserted after the marker are returned", () => {
    store.insertMessage(msg({ uid: 1, subject: "old" }));
    const marker = store.maxMessageId();
    store.insertMessage(msg({ uid: 2, subject: "new" }));
    expect(store.arrivedAfter(marker).map((m) => m.subject)).toEqual(["new"]);
  });

  test("a re-inserted message is not a new arrival", () => {
    store.insertMessage(msg({ uid: 1, subject: "code mail" }));
    const marker = store.maxMessageId();
    expect(store.insertMessage(msg({ uid: 1, subject: "code mail" }))).toBe(false);
    expect(store.arrivedAfter(marker)).toEqual([]);
  });

  test("newest mail comes first and folders stay out of it", () => {
    const marker = store.maxMessageId();
    store.insertMessage(msg({ uid: 5, subject: "older", date: 100 }));
    store.insertMessage(msg({ uid: 6, subject: "newer", date: 200 }));
    store.insertMessage(msg({ uid: 7, subject: "trashed", date: 300, mailbox: CLASS_TRASH }));
    expect(store.arrivedAfter(marker).map((m) => m.subject)).toEqual(["newer", "older"]);
  });

  test("an empty table has no marker and no arrivals", () => {
    expect(store.maxMessageId()).toBe(0);
    expect(store.arrivedAfter(0)).toEqual([]);
  });
});
