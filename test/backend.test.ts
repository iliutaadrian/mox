// backend().download — attachments always land in a uid-named subfolder, and a
// second call for the same message is a no-op that never touches IMAP again.
//
// fetchAllAttachments is the only mail.ts export download() calls; it's mocked
// here (real IMAP would need a live server bun test can't reach) via a mutable
// indirection object so each test controls what "the server" returns and can
// assert whether it was called at all. Every other mail.ts export is stubbed
// too, since mocking the module replaces all of its exports — nothing else in
// this file's tests reaches them.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fetchState: { impl: () => Promise<{ filename: string; data: Buffer }[]>; calls: number } = {
  impl: async () => [],
  calls: 0,
};

mock.module("../src/mail.ts", () => ({
  warmConnections: () => {},
  closeConnections: async () => {},
  detectFolders: async () => [],
  syncAll: async () => ({ fetched: 0 }),
  setSeen: async () => {},
  trashMessages: async () => new Map(),
  untrashMessages: async () => new Map(),
  archiveMessages: async () => new Map(),
  unarchiveMessages: async () => new Map(),
  reconcileFolders: async () => {},
  fetchBody: async () => ({ text: "", html: "" }),
  fetchBodies: async () => {},
  appendDraft: async () => ({ folder: "Drafts" }),
  fetchAllAttachments: async () => {
    fetchState.calls++;
    return fetchState.impl();
  },
}));

import { backend } from "../src/backend.ts";
import { CLASS_INBOX, Store, type NewMessage } from "../src/db.ts";
import { type Config } from "../src/config.ts";

const msg = (over: Partial<NewMessage> & { uid: number; subject: string }): NewMessage => ({
  account: "Test",
  mailbox: CLASS_INBOX,
  messageId: `<${over.uid}@example.com>`,
  fromAddr: "sender@example.com",
  fromName: "Sender",
  date: 1_780_000_000 - over.uid,
  snippet: "",
  body: "",
  html: "",
  attachments: [],
  seen: false,
  ...over,
});

const cfg: Config = {
  accounts: [{ name: "Test", imapHost: "127.0.0.1", imapPort: 1, imapUser: "tester@example.com", imapPass: "nope", mailbox: "INBOX" }],
  categories: [],
  fetchLimit: 50,
  fetchSinceDays: 0,
  contentDays: 0,
  inboxExclude: [],
  offlineCategories: [],
};

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mox-backend-"));
  // download() locates Attachments/ via resolveAttachmentsDir(resolveCfgPath()),
  // which reads these env vars first — without them it would fall back to the
  // repo (or worse, ~/Documents/mox) instead of this throwaway dir.
  process.env.MOX_CONFIG = join(dir, "config.yaml");
  process.env.MOX_DB = join(dir, "mox.db");
  store = new Store(join(dir, "mox.db"));
  fetchState.impl = async () => [];
  fetchState.calls = 0;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MOX_CONFIG;
  delete process.env.MOX_DB;
});

const attachmentsDir = () => join(dir, "Attachments");

describe("backend().download", () => {
  test("a single attachment still gets its own uid-named subfolder, not a loose file", async () => {
    store.insertMany([msg({ uid: 27568, subject: "Oxigen Tour - Comanda 27568" })]);
    const id = store.byIds([1])[0]!.id; // insertMany assigns ids sequentially from 1
    fetchState.impl = async () => [{ filename: "invoice.pdf", data: Buffer.from("hello") }];

    const be = backend(store, cfg);
    const res = await be.download(id);

    expect(res.ok).toBe(true);
    expect(fetchState.calls).toBe(1);

    const entries = readdirSync(attachmentsDir(), { withFileTypes: true });
    // Nothing loose at the root — everything lives inside a subfolder.
    expect(entries.every((e) => e.isDirectory())).toBe(true);
    expect(entries.length).toBe(1);
    expect(entries[0]!.name).toBe("27568");

    const files = readdirSync(join(attachmentsDir(), entries[0]!.name));
    expect(files).toEqual(["invoice.pdf"]);
  });

  test("multiple attachments share one uid-named subfolder, filenames stay collision-safe", async () => {
    store.insertMany([msg({ uid: 9001, subject: "Trip photos" })]);
    const id = store.byIds([1])[0]!.id;
    fetchState.impl = async () => [
      { filename: "photo.jpg", data: Buffer.from("a") },
      { filename: "photo.jpg", data: Buffer.from("b") }, // same name twice on purpose
    ];

    const be = backend(store, cfg);
    const res = await be.download(id);

    expect(res.ok).toBe(true);
    const entries = readdirSync(attachmentsDir(), { withFileTypes: true });
    expect(entries.length).toBe(1);
    expect(entries[0]!.name).toBe("9001");

    const files = readdirSync(join(attachmentsDir(), entries[0]!.name)).sort();
    expect(files).toEqual(["photo (2).jpg", "photo.jpg"]);
  });

  test("calling download twice on the same message is a no-op the second time", async () => {
    store.insertMany([msg({ uid: 4471, subject: "Invoice" })]);
    const id = store.byIds([1])[0]!.id;
    fetchState.impl = async () => [{ filename: "invoice.pdf", data: Buffer.from("hello") }];

    const be = backend(store, cfg);
    const first = await be.download(id);
    expect(first.ok).toBe(true);
    expect(fetchState.calls).toBe(1);

    const entriesAfterFirst = readdirSync(attachmentsDir());
    expect(entriesAfterFirst.length).toBe(1);

    const second = await be.download(id);
    expect(second.ok).toBe(true);
    expect(second.out).toContain("already downloaded");
    // The important assertion: no second IMAP fetch happened.
    expect(fetchState.calls).toBe(1);
    // And no duplicate/suffixed folder was created.
    expect(readdirSync(attachmentsDir())).toEqual(entriesAfterFirst);
  });
});
