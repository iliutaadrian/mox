// Automatic backups. The category/done/snooze state in the store exists nowhere
// else, so the assertion that matters is not "a file appeared" but "the snapshot
// is a database you can still read the mail out of" — a plain file copy of a WAL
// database passes the first check and fails the second.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backupDir, listBackups, maybeBackup } from "../src/backup.ts";
import type { Config } from "../src/config.ts";
import { CLASS_INBOX, Store, type NewMessage } from "../src/db.ts";

const HOUR = 3_600_000;

let dir: string;
let dbPath: string;

const cfg = (over: Partial<Config> = {}): Config => ({
  accounts: [],
  categories: [],
  fetchLimit: 200,
  fetchSinceDays: 0,
  contentDays: 90,
  inboxExclude: [],
  offlineCategories: [],
  backupEnabled: true,
  backupEveryHours: 12,
  backupKeep: 2,
  ...over,
});

const msg = (uid: number): NewMessage => ({
  account: "Test",
  mailbox: CLASS_INBOX,
  uid,
  messageId: `<${uid}@example.com>`,
  fromAddr: "sender@example.com",
  fromName: "Sender",
  subject: `Subject ${uid}`,
  date: 1_780_000_000 - uid,
  snippet: "",
  body: "",
  html: "",
  attachments: [],
  seen: false,
});

/**
 * Plant a backup file with a name + mtime as if it had been written at `at`.
 * A high keep count so seeding several does not prune the ones before it.
 */
function seedBackup(at: number): string {
  const r = maybeBackup(dbPath, cfg({ backupKeep: 100 }), at);
  expect(r.made).toBe(true);
  utimesSync(r.path!, new Date(at), new Date(at));
  return r.path!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mox-backup-"));
  dbPath = join(dir, "mox.db");
  // A store with real rows: the backup has to be verifiable by reading it.
  const store = new Store(dbPath);
  store.insertMany([msg(1), msg(2), msg(3)]);
  store.close();
});
afterEach(() => {
  // A failure test leaves the folder read-only; restore it so cleanup works.
  try {
    chmodSync(backupDir(dbPath), 0o755);
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("maybeBackup", () => {
  test("with no backup yet, writes a readable snapshot into backup/", () => {
    const r = maybeBackup(dbPath, cfg());

    expect(r.made).toBe(true);
    expect(r.pruned).toBe(0);
    expect(r.error).toBeUndefined();
    // Right folder, right name shape.
    expect(r.path!.startsWith(join(dir, "backup") + "/")).toBe(true);
    expect(r.path!).toMatch(/\/mox-\d{8}-\d{6}\.db$/);

    // The snapshot must be a valid database that still holds the mail.
    const snap = new Database(r.path!, { readonly: true });
    try {
      const n = snap.query("SELECT count(*) AS n FROM messages").get() as { n: number };
      expect(n.n).toBe(3);
      const subjects = (snap.query("SELECT subject FROM messages ORDER BY uid").all() as { subject: string }[]).map(
        (x) => x.subject,
      );
      expect(subjects).toEqual(["Subject 1", "Subject 2", "Subject 3"]);
    } finally {
      snap.close();
    }
  });

  test("backup/ lives next to the db, wherever the db is", () => {
    const nested = join(dir, "deeper");
    mkdirSync(nested);
    const other = join(nested, "mail.db");
    new Store(other).close();

    const r = maybeBackup(other, cfg());
    expect(r.made).toBe(true);
    expect(backupDir(other)).toBe(join(nested, "backup"));
    expect(r.path!).toMatch(/\/deeper\/backup\/mail-\d{8}-\d{6}\.db$/);
    // The db's own folder stays clean.
    expect(existsSync(join(dir, "backup"))).toBe(false);
  });

  test("does nothing while a recent backup exists", () => {
    const now = Date.now();
    expect(maybeBackup(dbPath, cfg(), now).made).toBe(true);

    // A minute later (distinct filename, so only the schedule can hold it back).
    const r = maybeBackup(dbPath, cfg(), now + 60_000);
    expect(r.made).toBe(false);
    expect(r.error).toBeUndefined();
    expect(listBackups(dbPath).length).toBe(1);
  });

  test("backs up again once the newest is older than the interval", () => {
    const now = Date.now();
    seedBackup(now - 13 * HOUR);

    const r = maybeBackup(dbPath, cfg(), now);
    expect(r.made).toBe(true);
    expect(listBackups(dbPath).length).toBe(2);
  });

  test("the interval is configurable", () => {
    const now = Date.now();
    seedBackup(now - 3 * HOUR);

    expect(maybeBackup(dbPath, cfg({ backupEveryHours: 12 }), now).made).toBe(false);
    expect(maybeBackup(dbPath, cfg({ backupEveryHours: 2 }), now).made).toBe(true);
  });

  test("prunes to the newest N and leaves unrelated files alone", () => {
    const now = Date.now();
    const oldest = seedBackup(now - 60 * HOUR);
    const middle = seedBackup(now - 40 * HOUR);
    const newest = seedBackup(now - 20 * HOUR);

    // Files the backup code did not create must survive pruning.
    const strays = [
      join(backupDir(dbPath), "notes.txt"),
      join(backupDir(dbPath), "mox.db"), // no timestamp: not ours
      join(backupDir(dbPath), "keepme-20200101-000000.db"), // different stem: not ours
    ];
    for (const s of strays) writeFileSync(s, "x");

    const r = maybeBackup(dbPath, cfg({ backupKeep: 2 }), now);
    expect(r.made).toBe(true);
    expect(r.pruned).toBe(2);

    const kept = listBackups(dbPath).map((f) => f.path);
    expect(kept.length).toBe(2);
    expect(kept).toContain(r.path!);
    expect(kept).toContain(newest);
    expect(existsSync(middle)).toBe(false);
    expect(existsSync(oldest)).toBe(false);
    for (const s of strays) expect(existsSync(s)).toBe(true);
  });

  test("keep count is configurable", () => {
    const now = Date.now();
    seedBackup(now - 60 * HOUR);
    seedBackup(now - 40 * HOUR);
    seedBackup(now - 20 * HOUR);

    const r = maybeBackup(dbPath, cfg({ backupKeep: 3 }), now);
    expect(r.pruned).toBe(1);
    expect(listBackups(dbPath).length).toBe(3);
  });

  test("enabled: false does nothing at all", () => {
    const r = maybeBackup(dbPath, cfg({ backupEnabled: false }));
    expect(r.made).toBe(false);
    expect(r.pruned).toBe(0);
    expect(existsSync(backupDir(dbPath))).toBe(false);
  });

  test("a missing database is not an error", () => {
    const r = maybeBackup(join(dir, "nope.db"), cfg());
    expect(r).toEqual({ made: false, pruned: 0 });
  });

  test("an unwritable backup folder returns cleanly instead of throwing", () => {
    const bdir = backupDir(dbPath);
    mkdirSync(bdir);
    chmodSync(bdir, 0o500); // readable + listable, not writable

    const r = maybeBackup(dbPath, cfg());
    expect(r.made).toBe(false);
    expect(r.error).toBeTruthy();
    chmodSync(bdir, 0o755);
    expect(readdirSync(bdir).length).toBe(0);
  });

  test("a backup path blocked by a plain file returns cleanly", () => {
    writeFileSync(backupDir(dbPath), "not a directory");

    const r = maybeBackup(dbPath, cfg());
    expect(r.made).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
