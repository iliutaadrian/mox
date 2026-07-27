// A throwaway mailbox for tests: a temp config + SQLite store seeded with
// synthetic mail. The E2E tests point MOX_CONFIG at this so they never touch the
// real mailbox — no IMAP, no server writes, no surprises. The account host is
// unroutable on purpose: the TUI pre-warms connections at startup and must
// tolerate that failing.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store, type NewMessage } from "../../src/db.ts";

export type Fixture = { dir: string; configPath: string; dbPath: string; env: Record<string, string> };

const CONFIG = `accounts:
  - name: Test
    imap_host: 127.0.0.1
    imap_port: 1
    imap_user: tester@example.com
    imap_pass: nope
    mailbox: INBOX

fetch_limit: 50
fetch_since_days: 30
content_days: 0
offline_categories: []
inbox_exclude: []

categories:
  - name: Bills
    match:
      domains: [billing.example.com]
      addresses: []
      words: [invoice]
`;

const HTML_MAIL = `<!DOCTYPE html>
<html><head><style>.x{color:red}</style></head>
<body>
  <div style="display:none">hidden preheader text</div>
  <!--[if mso]><table><tr><td>outlook only</td></tr></table><![endif]-->
  <table role="presentation"><tr><td>
    <h1>Quarterly update</h1>
    <p>Numbers are in. Read the <a href="https://example.com/report">full report</a> today.</p>
    <ul><li>Revenue up</li><li>Costs flat</li></ul>
    <p><a href="https://example.com/cta">Open dashboard</a></p>
    <img src="https://track.example.com/pixel.gif" width="1" height="1">
  </td></tr></table>
  <p>You can <a href="https://example.com/unsubscribe">unsubscribe</a> at any time. © Example</p>
</body></html>`;

const PLAIN_MAIL = `Salut,

Prima linie cu diacritice: ăîșț. Vezi https://example.org/deal pentru detalii.

> Mesajul anterior
> a doua linie citată

--
Semnătură
`;

function msg(over: Partial<NewMessage> & { uid: number; subject: string }): NewMessage {
  return {
    account: "Test",
    mailbox: "INBOX",
    messageId: `<${over.uid}@example.com>`,
    fromAddr: "sender@example.com",
    fromName: "Example Sender",
    date: 1_780_000_000 - over.uid * 3600,
    snippet: over.subject,
    body: "",
    html: "",
    attachments: [],
    seen: false,
    ...over,
  };
}

/** Build the fixture mailbox. Returns paths plus the env to hand runTui(). */
export function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "mox-fixture-"));
  const configPath = join(dir, "config.yaml");
  const dbPath = join(dir, "mox.db");
  writeFileSync(configPath, CONFIG);

  const store = new Store(dbPath);
  const rows: NewMessage[] = [
    msg({ uid: 1001, subject: "Quarterly update", html: HTML_MAIL, body: "Numbers are in." }),
    msg({ uid: 1002, subject: "Plain text note", body: PLAIN_MAIL }),
    msg({ uid: 1003, subject: "invoice 4471 from billing", fromAddr: "no-reply@billing.example.com", body: "Amount due: 42 RON" }),
    msg({
      uid: 1004,
      subject: "With attachment",
      body: "See the attached file.",
      attachments: [{ name: "report.pdf", type: "application/pdf", size: 2048 }],
    }),
    msg({ uid: 1005, subject: "Long body for scrolling", body: Array.from({ length: 120 }, (_, i) => `line ${i + 1} of the long body`).join("\n") }),
  ];
  // Enough filler to exercise list paging (half-page = 10 rows).
  for (let i = 0; i < 30; i++) rows.push(msg({ uid: 2000 + i, subject: `Filler message ${i + 1}`, body: `body ${i + 1}` }));
  store.insertMany(rows);
  store.close();

  // MOX_DB matters as much as MOX_CONFIG: without it a config outside the repo
  // resolves to ~/Documents/mox/mox.db — the real installed mailbox.
  return { dir, configPath, dbPath, env: { MOX_CONFIG: configPath, MOX_DB: dbPath } };
}
