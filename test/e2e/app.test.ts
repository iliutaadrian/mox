// End-to-end tests against the REAL <App/>: mounted in OpenTUI's test renderer,
// driven with real key and mouse events, asserted on the painted screen.
//
// Every test gets a fixture mailbox (temp config + temp SQLite) whose account
// points at an unroutable host, so nothing here reads or writes the real mailbox
// and no IMAP traffic happens. Server-mutating keys (`t` trash, `a` archive)
// would need a live connection, so they are covered by the store tests instead —
// what IS covered here is that `d` no longer trashes after the rebinding.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

import { Store } from "../../src/db.ts";
import { makeFixture, type Fixture } from "../helpers/fixture.ts";
import { hint, KEY, pane, startApp, type Harness } from "../helpers/tui.ts";

let fx: Fixture;
let app: Harness;
const isDarwin = process.platform === "darwin";

const readClipboard = () => (isDarwin ? (spawnSync("pbpaste", { encoding: "utf8" }).stdout ?? "") : "");
const writeClipboard = (s: string) => {
  if (isDarwin) spawnSync("pbcopy", { input: s, encoding: "utf8" });
};

// The clipboard belongs to whoever is at the keyboard: borrow it, then put the
// original contents back when the suite finishes.
let savedClipboard = "";
beforeAll(() => {
  savedClipboard = readClipboard();
});
afterAll(() => {
  writeClipboard(savedClipboard);
});

beforeEach(async () => {
  fx = makeFixture();
  app = await startApp(fx);
});
afterEach(() => {
  app.stop();
  rmSync(fx.dir, { recursive: true, force: true });
});

/** Where a piece of text sits on screen, so mouse tests are not hard-coded. */
function findText(frame: string, needle: string): { row: number; col: number } | null {
  const rows = frame.split("\n");
  for (let r = 0; r < rows.length; r++) {
    const c = rows[r]!.indexOf(needle);
    if (c >= 0) return { row: r, col: c };
  }
  return null;
}

const openedId = (frame: string) => /Id:\s+(\d+)/.exec(frame)?.[1];

describe("startup", () => {
  test("paints the sidebar, the message list and the footer hints", () => {
    const frame = app.frame();
    expect(frame).toContain("mox");
    expect(frame).toContain("INBOX");
    expect(frame).toContain("Quarterly update");
    expect(frame).toContain("Example Sender");
    expect(frame).not.toContain("undefined");
  });

  test("the footer advertises the current keys, not the pre-rebinding ones", () => {
    const footer = hint(app.frame());
    expect(footer).toContain("t trash");
    expect(footer).toContain("d/u page");
    expect(footer).not.toContain("d trash");
    expect(footer).not.toContain("u restore");
  });

  test("an unreachable mail server does not break the UI", () => {
    // The fixture account points at 127.0.0.1:1 and startup pre-warms IMAP.
    expect(app.frame()).toContain("INBOX");
  });
});

describe("reading a message", () => {
  beforeEach(async () => {
    await app.key(KEY.enter);
  });

  test("enter opens the reader with headers", () => {
    const frame = app.frame();
    expect(frame).toContain("Id:");
    expect(frame).toContain("Mailbox: Test");
    expect(frame).toContain("From:");
    expect(frame).toContain("Subject:");
  });

  test("HTML is flowed to text with numbered link references", () => {
    const frame = app.frame();
    expect(frame).toContain("Quarterly update");
    expect(frame).toContain("HTML email — v browser");
    expect(frame).toMatch(/\[\d+\]full report/); // lynx numbers the anchors
    expect(frame).toContain("* Revenue up"); // the list survives
    expect(frame).not.toContain("<table"); // no raw markup leaks through
    // Documents today's behaviour: lynx ignores CSS, so a display:none
    // preheader IS shown. Change this test if the reader starts cleaning HTML.
    expect(frame).toContain("hidden preheader");
  });

  test("the reader hint lists the reading-mode keys", () => {
    const footer = hint(app.frame());
    expect(footer).toContain("d/u page");
    expect(footer).toContain("g/G ends");
    expect(footer).toContain("y copy");
  });

  test("escape returns to the list", async () => {
    await app.key(KEY.escape);
    expect(app.frame()).toContain("Quarterly update");
    expect(hint(app.frame())).toContain("enter open");
  });

  test("h/l move to the previous/next email", async () => {
    const first = openedId(app.frame());
    await app.type("l");
    const second = openedId(app.frame());
    expect(second).not.toBe(first);
    await app.type("h");
    expect(openedId(app.frame())).toBe(first);
  });
});

describe("scrolling is bounded", () => {
  // The long-body fixture message is the 5th row.
  const openLong = async () => {
    await app.type("l");
    await app.type("jjjj");
    await app.key(KEY.enter);
  };

  test("G reaches the end of the email", async () => {
    await openLong();
    await app.type("G");
    expect(app.frame()).toContain("line 120 of the long body");
  });

  test("g returns to the top", async () => {
    await openLong();
    await app.type("G");
    await app.type("g");
    expect(app.frame()).toContain("Id:");
  });

  test("regression: scrolling past the end keeps content on screen", async () => {
    await openLong();
    await app.type("G");
    await app.type("jjjjjjjjjj"); // ten more presses at the bottom
    const rows = pane(app.frame());
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.join("\n")).toContain("line 120 of the long body");
  });

  test("d pages down and u comes back", async () => {
    await openLong();
    const top = app.frame();
    await app.type("d");
    const paged = app.frame();
    expect(paged).not.toBe(top);
    await app.type("u");
    expect(app.frame()).toContain("Id:");
  });
});

describe("list navigation", () => {
  test("d moves the cursor a half page down", async () => {
    await app.key(KEY.enter);
    const firstId = openedId(app.frame());
    await app.key(KEY.escape);
    await app.type("l"); // focus the list
    await app.type("d");
    await app.key(KEY.enter);
    expect(openedId(app.frame())).not.toBe(firstId);
  });

  test("j moves one row", async () => {
    await app.type("l");
    await app.key(KEY.enter);
    const a = openedId(app.frame());
    await app.key(KEY.escape);
    await app.type("j");
    await app.key(KEY.enter);
    expect(openedId(app.frame())).not.toBe(a);
  });

  test("regression: d does not trash (trash moved to t)", async () => {
    await app.type("l");
    await app.type("d");
    // Nothing was moved on the server, and the message is still listed.
    expect(app.frame()).toContain("Quarterly update");
    expect(app.frame()).not.toContain("Trashing on server");
    const store = new Store(fx.dbPath);
    const inbox = store.list({ kind: "inbox", exclude: [] }, 100);
    store.close();
    expect(inbox.length).toBe(35);
  });
});

describe("done and restore", () => {
  test("e marks done (it leaves the inbox) and z restores it from ALL", async () => {
    await app.type("e");
    let store = new Store(fx.dbPath);
    expect(store.list({ kind: "inbox", exclude: [] }, 100).length).toBe(34);
    store.close();

    // Jump to ALL, where done mail is visible, and restore it.
    await app.type("g");
    await app.type("ALL");
    await app.key(KEY.enter);
    await app.type("z");

    store = new Store(fx.dbPath);
    const back = store.list({ kind: "inbox", exclude: [] }, 100).length;
    store.close();
    expect(back).toBe(35);
  });
});

describe("search", () => {
  test("/ filters the view and escape clears it", async () => {
    await app.type("/");
    await app.type("invoice");
    await app.key(KEY.enter);
    expect(app.frame()).toContain('search: "invoice"');
    expect(app.frame()).toContain("invoice 4471");
    await app.key(KEY.escape);
    expect(app.frame()).toContain("Quarterly update");
  });

  test("from: narrows by sender", async () => {
    await app.type("/");
    await app.type("from:billing");
    await app.key(KEY.enter);
    expect(app.frame()).toContain("invoice 4471");
  });
});

describe("link picker", () => {
  test("o lists the email's links and escape dismisses it", async () => {
    await app.key(KEY.enter);
    await app.type("o");
    const frame = app.frame();
    expect(frame).toContain("Open numbered link");
    expect(frame).toContain("example.com/report");
    await app.key(KEY.escape);
    expect(app.frame()).not.toContain("Open numbered link");
  });

  test("typing narrows the list", async () => {
    await app.key(KEY.enter);
    await app.type("o");
    await app.type("report");
    const frame = app.frame();
    expect(frame).toContain("/report▏"); // the typed query
    expect(frame).toContain("> [1] example.com/report");
    // Only one candidate is left inside the picker box.
    expect(frame.split("\n").filter((l) => /^\W*[>\s]\s*\[\d+\]\s+\S+\s+\W*$/.test(l)).length).toBe(1);
  });

  test("a message with no links says so", async () => {
    await app.type("l");
    await app.type("jj"); // the plain-text invoice has no links
    await app.key(KEY.enter);
    await app.type("o");
    expect(app.frame()).toContain("no links in this email");
  });
});

describe("copy mode", () => {
  test("y shows the copy-mode hint and escape leaves it", async () => {
    await app.key(KEY.enter);
    await app.type("y");
    expect(hint(app.frame())).toContain("COPY");
    await app.key(KEY.escape);
    expect(hint(app.frame())).not.toContain("COPY");
  });

  test("v switches the hint to SELECTING", async () => {
    await app.key(KEY.enter);
    await app.type("y");
    await app.type("v");
    expect(hint(app.frame())).toContain("SELECTING");
  });

  test.if(isDarwin)("y then i copies the message id", async () => {
    writeClipboard("SENTINEL");
    await app.key(KEY.enter);
    const id = openedId(app.frame());
    await app.type("y");
    await app.type("i");
    expect(readClipboard().trim()).toBe(id);
    expect(app.frame()).toContain("copied id");
  });

  test.if(isDarwin)("y then f copies the sender address", async () => {
    writeClipboard("SENTINEL");
    await app.key(KEY.enter);
    await app.type("y");
    await app.type("f");
    expect(readClipboard().trim()).toBe("sender@example.com");
  });

  test.if(isDarwin)("y then y copies the cursor's line", async () => {
    writeClipboard("SENTINEL");
    await app.key(KEY.enter);
    await app.type("y");
    await app.type("y");
    expect(readClipboard()).toContain("Id:");
  });

  test.if(isDarwin)("v plus l extends a character selection that y copies", async () => {
    writeClipboard("SENTINEL");
    await app.key(KEY.enter);
    await app.type("y");
    await app.type("v");
    await app.type("lll");
    await app.type("y");
    const clip = readClipboard();
    expect(clip).not.toBe("SENTINEL");
    expect(clip.length).toBeGreaterThan(0);
    expect(clip.length).toBeLessThanOrEqual(8); // characters, not the whole line
  });

  test.if(isDarwin)("a mouse drag copies the dragged text on release", async () => {
    writeClipboard("SENTINEL");
    await app.key(KEY.enter);
    const at = findText(app.frame(), "Mailbox: Test");
    expect(at).not.toBeNull();
    // Drag across the word "Test" on the Mailbox header line.
    const startCol = at!.col + "Mailbox: ".length;
    await app.mockMouse.drag(startCol, at!.row, startCol + 4, at!.row);
    await app.flush();
    const clip = readClipboard();
    expect(clip).not.toBe("SENTINEL");
    expect(clip.trim().length).toBeGreaterThan(0);
  });
});

describe("attachments", () => {
  test("the list marks mail carrying files", () => {
    expect(app.frame()).toContain("📎");
  });

  test("the reader lists the attachment", async () => {
    await app.type("l");
    await app.type("jjj"); // the 4th fixture message has a PDF
    await app.key(KEY.enter);
    expect(app.frame()).toContain("report.pdf");
    expect(hint(app.frame())).toContain("s save files");
  });
});

describe("goto picker", () => {
  test("g opens it and filters, enter jumps", async () => {
    await app.type("g");
    expect(app.frame()).toContain("Go to view");
    await app.type("ALL");
    await app.key(KEY.enter);
    expect(app.frame()).not.toContain("Go to view");
  });
});
