// The write side of the MCP surface. The tool handlers themselves live inside
// src/mcp.ts, which connects to stdio the moment it is imported, so the layers
// underneath (Store + backend actions) are tested directly, and the server
// itself only through a spawned stdio smoke test.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { CLASS_INBOX, CLASS_TRASH, SOURCE_MANUAL, Store, type NewMessage } from "../src/db.ts";
import { backend } from "../src/backend.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { makeFixture } from "./helpers/fixture.ts";

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

// No accounts: every action exercised here is local-only and must never reach
// out to IMAP. An empty account list makes an accidental server call impossible.
const cfg: Config = {
  accounts: [],
  categories: [{ name: "Travel" }],
  fetchLimit: 50,
  fetchSinceDays: 0,
  contentDays: 0,
  inboxExclude: [],
  offlineCategories: [],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mox-mcp-"));
  store = new Store(join(dir, "test.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("setCategoryBySender", () => {
  const seed = () =>
    store.insertMany([
      msg({ uid: 1, fromAddr: "oxigen@contact.ro" }),
      msg({ uid: 2, fromAddr: "oxigen@contact.ro" }),
      msg({ uid: 3, fromAddr: "someone@else.example" }),
    ]);

  test("re-files every message from that sender and reports the count", () => {
    seed();
    expect(store.setCategoryBySender("oxigen@contact.ro", "Travel")).toBe(2);
    expect(store.list({ kind: "category", name: "Travel" }, 10).length).toBe(2);
  });

  test("leaves other senders alone", () => {
    seed();
    store.setCategoryBySender("oxigen@contact.ro", "Travel");
    const other = store.list({ kind: "all", exclude: [] }, 10).find((m) => m.from_addr === "someone@else.example")!;
    expect(other.category).toBe("");
  });

  test("marks the source manual so --reclassify cannot undo it", () => {
    seed();
    store.setCategoryBySender("oxigen@contact.ro", "Travel");
    const row = store.list({ kind: "category", name: "Travel" }, 1)[0]!;
    expect(store.full(row.id)!.source).toBe(SOURCE_MANUAL);
    expect(store.reclassifiable().map((r) => r.id)).not.toContain(row.id);
  });

  test("matches the address case-insensitively", () => {
    seed();
    expect(store.setCategoryBySender("  OxiGen@Contact.RO  ", "Travel")).toBe(2);
  });

  test("does nothing for an unknown address", () => {
    seed();
    expect(store.setCategoryBySender("nobody@nowhere.example", "Travel")).toBe(0);
    expect(store.list({ kind: "category", name: "Travel" }, 10).length).toBe(0);
  });

  test("does nothing for an empty address (never a catch-all sweep)", () => {
    seed();
    expect(store.setCategoryBySender("   ", "Travel")).toBe(0);
  });

  test("only touches INBOX mail - a category is meaningless in Trash", () => {
    store.insertMany([
      msg({ uid: 1, fromAddr: "oxigen@contact.ro" }),
      msg({ uid: 2, fromAddr: "oxigen@contact.ro", mailbox: CLASS_TRASH }),
    ]);
    expect(store.setCategoryBySender("oxigen@contact.ro", "Travel")).toBe(1);
    expect(store.list({ kind: "folder", class: CLASS_TRASH }, 10)[0]!.category).toBe("");
  });
});

describe("backend().done", () => {
  test("done takes mail out of the inbox view, undone puts it back", () => {
    store.insertMany([msg({ uid: 1 }), msg({ uid: 2 })]);
    const be = backend(store, cfg);
    const first = store.list({ kind: "inbox", exclude: [] }, 10)[0]!;

    const marked = be.done([first.id], true);
    expect(marked.ok).toBe(true);
    expect(marked.out).toBe("done 1");
    expect(store.list({ kind: "inbox", exclude: [] }, 10).map((m) => m.id)).not.toContain(first.id);
    // Local-only: still there, just not active.
    expect(store.list({ kind: "all", exclude: [] }, 10).length).toBe(2);

    const restored = be.done([first.id], false);
    expect(restored.ok).toBe(true);
    expect(restored.out).toBe("restored 1 to inbox");
    expect(store.list({ kind: "inbox", exclude: [] }, 10).map((m) => m.id)).toContain(first.id);
  });
});

describe("backend().moveBySender", () => {
  test("reports the count, and says so when the sender has no mail", () => {
    store.insertMany([msg({ uid: 1, fromAddr: "oxigen@contact.ro" })]);
    const be = backend(store, cfg);
    expect(be.moveBySender("oxigen@contact.ro", "Travel").out).toBe("moved 1 from oxigen@contact.ro to Travel");
    expect(be.moveBySender("ghost@contact.ro", "Travel").out).toBe("no mail from ghost@contact.ro");
  });
});

// End-to-end over stdio: the real server process, pointed at a fixture mailbox
// so it can never reach the installed one. Read-only calls only - the write
// tools would need a live IMAP server.
describe("the server over stdio", () => {
  let fx: ReturnType<typeof makeFixture>;
  let client: Client;

  beforeEach(async () => {
    fx = makeFixture();
    client = new Client({ name: "mox-test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath, // bun
        args: [join(import.meta.dir, "..", "src", "mcp.ts")],
        env: { ...(process.env as Record<string, string>), ...fx.env },
      }),
    );
  });
  afterEach(async () => {
    await client.close();
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test("advertises every tool", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "create_draft",
      "download_attachments",
      "get_email",
      "get_inbox",
      "search_emails",
      "set_category",
      "triage_emails",
    ]);
  });

  test("get_inbox returns the fixture mail newest first", async () => {
    const res = await client.callTool({ name: "get_inbox", arguments: { limit: 5 } });
    const rows = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(rows.length).toBe(5);
    expect(rows.map((r: { date: number }) => r.date)).toEqual([...rows.map((r: { date: number }) => r.date)].sort((a, b) => b - a));
  });

  test("set_category refuses a category the user never configured", async () => {
    const res = await client.callTool({ name: "set_category", arguments: { category: "Invented", from: "sender@example.com" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toContain("unknown category");
  });
});

// The shipped entry point: `mox mcp` routes through index.tsx, which is also the
// TUI's entry. Spawning src/mcp.ts proves nothing about that dispatch — the arg
// routing, and above all that no terminal code writes a byte to stdout before
// the protocol takes over (a single stray line breaks the handshake below).
describe("`mox mcp` through the binary entry point", () => {
  let fx: ReturnType<typeof makeFixture>;
  let client: Client;

  beforeEach(async () => {
    fx = makeFixture();
    client = new Client({ name: "mox-test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath, // bun
        args: [join(import.meta.dir, "..", "src", "index.tsx"), "mcp"],
        env: { ...(process.env as Record<string, string>), ...fx.env },
      }),
    );
  });
  afterEach(async () => {
    await client.close();
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test("completes the handshake and advertises the same tools", async () => {
    expect(client.getServerVersion()?.name).toBe("mox");
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "create_draft",
      "download_attachments",
      "get_email",
      "get_inbox",
      "search_emails",
      "set_category",
      "triage_emails",
    ]);
  });

  test("serves a read call over the routed server", async () => {
    const res = await client.callTool({ name: "get_inbox", arguments: { limit: 3 } });
    expect(JSON.parse((res.content as { text: string }[])[0]!.text).length).toBe(3);
  });
});

describe("done reports real work", () => {
  // A tool Claude drives must not claim more than it changed: unknown ids, and
  // ids that already carry the flag, are not work done.
  test("counts only rows that actually flipped", () => {
    const fx = makeFixture();
    const store = new Store(fx.dbPath);
    const cfg = loadConfig(fx.configPath);
    const be = backend(store, cfg);
    const ids = store.list({ kind: "inbox", exclude: [] }, 3).map((m) => m.id);

    expect(be.done(ids, true).out).toBe(`done ${ids.length}`);
    expect(be.done(ids, true).out).toBe("done 0"); // already done
    expect(be.done([999_999], true).out).toBe("done 0"); // no such message
    expect(be.done(ids, false).out).toBe(`restored ${ids.length} to inbox`);

    store.close();
    rmSync(fx.dir, { recursive: true, force: true });
  });
});
