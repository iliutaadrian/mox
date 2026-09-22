// Config parsing. The headless keys decide whether `mox` boots a TUI or a
// never-exiting sync loop, so the defaults matter: a missing or misspelled key
// must leave a desktop install interactive, and a garbage interval must fall
// back to something sane rather than spinning the IMAP connection.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadConfig } from "../src/config.ts";
import { backupDir } from "../src/backup.ts";
import { resolveAttachmentsDir, resolveDbPath } from "../src/paths.ts";

let dir: string;

const write = (yaml: string): string => {
  const p = join(dir, "config.yaml");
  writeFileSync(p, yaml);
  return p;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mox-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("headless config", () => {
  test("defaults to off with a 60s interval", () => {
    const cfg = loadConfig(write("accounts: []\n"));
    expect(cfg.headless).toBe(false);
    expect(cfg.headlessEverySeconds).toBe(60);
  });

  test("headless: true turns it on", () => {
    const cfg = loadConfig(write("headless: true\nheadless_every_seconds: 15\n"));
    expect(cfg.headless).toBe(true);
    expect(cfg.headlessEverySeconds).toBe(15);
  });

  // Only the literal `true` enables it — a string or a number in that slot is a
  // typo, and quietly booting a daemon instead of the TUI would be baffling.
  test("only a real boolean enables it", () => {
    expect(loadConfig(write('headless: "yes"\n')).headless).toBe(false);
    expect(loadConfig(write("headless: 1\n")).headless).toBe(false);
    expect(loadConfig(write("headless: false\n")).headless).toBe(false);
  });

  test("a garbage or non-positive interval falls back to 60s", () => {
    expect(loadConfig(write("headless_every_seconds: 0\n")).headlessEverySeconds).toBe(60);
    expect(loadConfig(write("headless_every_seconds: -5\n")).headlessEverySeconds).toBe(60);
    expect(loadConfig(write("headless_every_seconds: soon\n")).headlessEverySeconds).toBe(60);
  });
});

describe("refresh_every_seconds", () => {
  test("defaults to the 10s the TUI has always used", () => {
    expect(loadConfig(write("accounts: []\n")).refreshEverySeconds).toBe(10);
  });

  test("is read from config and never drops to zero", () => {
    expect(loadConfig(write("refresh_every_seconds: 30\n")).refreshEverySeconds).toBe(30);
    // A 0 here would spin the sync loop flat out against the IMAP server.
    expect(loadConfig(write("refresh_every_seconds: 0\n")).refreshEverySeconds).toBe(10);
    expect(loadConfig(write("refresh_every_seconds: nope\n")).refreshEverySeconds).toBe(10);
  });
});

describe("data_dir", () => {
  test("unset leaves the built-in paths alone", () => {
    const p = write("accounts: []\n");
    const cfg = loadConfig(p);
    expect(cfg.dataDir).toBe("");
    // With no data_dir and no $MOX_DB, resolution falls back to the installed
    // default — the point being that an absent key changes nothing.
    delete process.env.MOX_DB;
    expect(resolveDbPath(p, cfg)).toBe(join(homedir(), "Documents", "mox", "mox.db"));
  });

  test("moves the database and its attachments together", () => {
    const cfg = loadConfig(write(`data_dir: ${join(dir, "store")}\n`));
    delete process.env.MOX_DB;
    expect(resolveDbPath(write(""), cfg)).toBe(join(dir, "store", "mox.db"));
    expect(resolveAttachmentsDir(write(""), cfg)).toBe(join(dir, "store", "Attachments"));
  });

  test("expands ~ and resolves a relative path", () => {
    expect(loadConfig(write("data_dir: ~/mail\n")).dataDir).toBe(join(homedir(), "mail"));
    expect(loadConfig(write("data_dir: ./store\n")).dataDir).toBe(resolve("./store"));
  });

  // $MOX_DB is how the tests and one-off runs point mox at a scratch database;
  // a data_dir in the user's config must not quietly win over it.
  test("$MOX_DB still wins", () => {
    const cfg = loadConfig(write(`data_dir: ${join(dir, "store")}\n`));
    process.env.MOX_DB = join(dir, "override.db");
    expect(resolveDbPath(write(""), cfg)).toBe(join(dir, "override.db"));
    delete process.env.MOX_DB;
  });
});

describe("backup_dir", () => {
  test("unset means a backup/ folder next to the database", () => {
    const cfg = loadConfig(write("accounts: []\n"));
    expect(cfg.backupDir).toBe("");
    expect(backupDir(join(dir, "mox.db"), cfg)).toBe(join(dir, "backup"));
  });

  test("set sends snapshots somewhere else entirely", () => {
    const cfg = loadConfig(write(`backup_dir: ${join(dir, "snapshots")}\n`));
    expect(backupDir(join(dir, "mox.db"), cfg)).toBe(join(dir, "snapshots"));
  });

  test("expands ~ like the other paths", () => {
    expect(loadConfig(write("backup_dir: ~/mox-backups\n")).backupDir).toBe(join(homedir(), "mox-backups"));
  });
});

describe("login_codes", () => {
  // The word list is the on/off switch: there is no built-in set behind it, so
  // a config written before this feature existed must leave it fully dormant.
  test("an absent block means no words and nothing fires", () => {
    const cfg = loadConfig(write("accounts: []\n"));
    expect(cfg.loginCodeWords).toEqual([]);
  });

  test("words are read, trimmed and emptied entries dropped", () => {
    const cfg = loadConfig(write("login_codes:\n  words: ['  cod ', code, '']\n"));
    expect(cfg.loginCodeWords).toEqual(["cod", "code"]);
  });

  test("auto_copy and notify default on when the block exists", () => {
    const cfg = loadConfig(write("login_codes:\n  words: [code]\n"));
    expect(cfg.loginCodeAutoCopy).toBe(true);
    expect(cfg.loginCodeNotify).toBe(true);
  });

  test("either switch can be turned off on its own", () => {
    const cfg = loadConfig(write("login_codes:\n  words: [code]\n  auto_copy: false\n  notify: false\n"));
    expect(cfg.loginCodeAutoCopy).toBe(false);
    expect(cfg.loginCodeNotify).toBe(false);
  });

  test("the shipped example config parses with the feature on", () => {
    const cfg = loadConfig("config.example.yaml");
    expect(cfg.loginCodeWords.length).toBeGreaterThan(10);
    expect(cfg.loginCodeAutoCopy).toBe(true);
  });
});
