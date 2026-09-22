// The auto-copy step. Every test here stays on a path that does NOT reach the
// system clipboard: a test that copies would stomp whatever the person running
// it had copied, which is exactly the failure this feature is built to avoid.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codesEnabled, copyArrivedCode } from "../src/autocopy.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { CLASS_INBOX, Store, type NewMessage } from "../src/db.ts";

let dir: string;
let store: Store;

const cfgFrom = (yaml: string): Config => {
  const p = join(dir, "config.yaml");
  writeFileSync(p, yaml);
  return loadConfig(p);
};

const msg = (over: Partial<NewMessage> & { uid: number }): NewMessage => ({
  account: "Test",
  mailbox: CLASS_INBOX,
  messageId: `<${over.uid}@example.com>`,
  fromAddr: "sender@example.com",
  fromName: "Sender",
  subject: "Subject",
  date: 1_780_000_000,
  snippet: "",
  body: "",
  html: "",
  attachments: [],
  seen: false,
  ...over,
});

const LISTS = "login_codes_words: [cod de siguranta]\nlogin_codes_subject_words: [code]\n";
const ON = "login_codes: true\n" + LISTS;
const OFF = "login_codes: false\n" + LISTS;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mox-autocopy-"));
  store = new Store(join(dir, "mox.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("codesEnabled", () => {
  test("needs the master switch AND at least one word", () => {
    expect(codesEnabled(cfgFrom(ON))).toBe(true);
    expect(codesEnabled(cfgFrom("login_codes: true\n"))).toBe(false);
    expect(codesEnabled(cfgFrom(LISTS))).toBe(false);
    expect(codesEnabled(cfgFrom(OFF))).toBe(false);
  });
});

describe("copyArrivedCode", () => {
  // A qualifying mail is present in every case below, so each null proves the
  // switch did the stopping — not the absence of a code.
  const withCodeMail = () => {
    const marker = store.maxMessageId();
    store.insertMessage(msg({ uid: 1, subject: "Cod de siguranta", body: "Cod de siguranta: 735470, expira dupa 300 secunde." }));
    return marker;
  };

  test("the master switch off means nothing is touched", () => {
    const marker = withCodeMail();
    expect(copyArrivedCode(store, cfgFrom(OFF), marker)).toBeNull();
  });

  test("auto_copy off leaves the clipboard alone (yc still works separately)", () => {
    const marker = withCodeMail();
    expect(copyArrivedCode(store, cfgFrom(ON + "login_codes_auto_copy: false\n"), marker)).toBeNull();
  });

  test("an empty word list means nothing qualifies", () => {
    const marker = withCodeMail();
    expect(copyArrivedCode(store, cfgFrom("login_codes: true\n"), marker)).toBeNull();
  });

  test("mail already held is not an arrival", () => {
    store.insertMessage(msg({ uid: 1, subject: "Cod de siguranta", body: "Cod de siguranta: 735470." }));
    // Marker taken AFTER the message is stored: a later sync re-yielding it
    // inserts nothing, so it must never be copied a second time.
    const marker = store.maxMessageId();
    expect(copyArrivedCode(store, cfgFrom(ON), marker)).toBeNull();
  });

  test("an arrival with no code qualifies nothing", () => {
    const marker = store.maxMessageId();
    store.insertMessage(msg({ uid: 2, subject: "Deployment is live", body: "build 482910 finished" }));
    expect(copyArrivedCode(store, cfgFrom(ON), marker)).toBeNull();
  });
});
