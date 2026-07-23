// Seeds a fully fictional demo mailbox used ONLY to render the README
// screenshots — no real people, senders or data. Run: bun docs/demo/seed.ts
// Output: docs/demo/mox.db (git-ignored). Pair with docs/demo/config.yaml.
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dbPath = join(import.meta.dir, "mox.db");
for (const p of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
  try {
    rmSync(p);
  } catch {}
}

const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL, mailbox TEXT NOT NULL, uid INTEGER NOT NULL,
    message_id TEXT, from_addr TEXT, from_name TEXT, subject TEXT,
    date INTEGER, snippet TEXT, body TEXT, html TEXT, attachments TEXT,
    seen INTEGER NOT NULL DEFAULT 0, category TEXT, confidence TEXT,
    suggested_new TEXT, source TEXT, classified_at INTEGER,
    done INTEGER NOT NULL DEFAULT 0, snoozed_until INTEGER NOT NULL DEFAULT 0,
    UNIQUE(account, mailbox, uid)
  );
  CREATE INDEX idx_messages_mailbox ON messages(mailbox, date);
  CREATE TABLE sync_state (account TEXT, mailbox TEXT, uid_validity INTEGER DEFAULT 0, last_uid INTEGER DEFAULT 0, PRIMARY KEY(account, mailbox));
  CREATE TABLE approved_categories (name TEXT PRIMARY KEY, description TEXT, created_at INTEGER);
`);

const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const DAY = 86400;
let uid = 1000;

type Msg = {
  account?: string;
  mailbox?: string;
  from_name: string;
  from_addr: string;
  subject: string;
  category?: string;
  ago: number; // seconds before now
  seen?: 0 | 1;
  done?: 0 | 1;
  body?: string;
};

const ins = db.prepare(
  `INSERT INTO messages (account, mailbox, uid, message_id, from_addr, from_name, subject, date, snippet, body, html, attachments, seen, category, source, classified_at, done)
   VALUES ($account,$mailbox,$uid,$mid,$from_addr,$from_name,$subject,$date,$snippet,$body,NULL,'[]',$seen,$category,'rule',$date,$done)`,
);

function add(m: Msg) {
  const date = NOW - m.ago;
  ins.run({
    $account: m.account ?? "Personal",
    $mailbox: m.mailbox ?? "INBOX",
    $uid: uid++,
    $mid: `<demo-${uid}@example.com>`,
    $from_addr: m.from_addr,
    $from_name: m.from_name,
    $subject: m.subject,
    $date: date,
    $snippet: (m.body ?? m.subject).slice(0, 120),
    $body: m.body ?? m.subject,
    $seen: m.seen ?? 1,
    $category: m.category ?? "Other",
    $done: m.done ?? 0,
  });
}

// ---- curated INBOX (newest first drives the reading-pane shot) ----
const inbox: Msg[] = [
  {
    from_name: "GitHub",
    from_addr: "notifications@github.com",
    subject: "[acme/web] A third-party OAuth app was added to your account",
    category: "Work",
    account: "Work",
    ago: HOUR,
    seen: 0,
    body: [
      "Hey there,",
      "",
      "A third-party OAuth application (Deploy Previews) with read-only access",
      "to public information was recently authorized to access your account.",
      "Visit https://github.com/settings/connections for more information.",
      "",
      "To see this and other security events, visit your security log.",
      "",
      "Thanks,",
      "The GitHub Team",
    ].join("\n"),
  },
  { from_name: "PowerCo", from_addr: "billing@power-co.example", subject: "Your March electricity invoice is ready", category: "Bills", ago: 3 * HOUR, seen: 0 },
  { from_name: "Northbank", from_addr: "alerts@northbank.example", subject: "Statement available for account ••4417", category: "Finance", ago: 5 * HOUR, seen: 0 },
  { from_name: "Jira", from_addr: "jira@acme.example", subject: "Dana Meyer mentioned you on WEB-2231", category: "Work", account: "Work", ago: 8 * HOUR },
  { from_name: "FlyAway", from_addr: "bookings@flyaway.example", subject: "Your trip to Lisbon — check-in opens tomorrow", category: "Travel", ago: 11 * HOUR, seen: 0 },
  { from_name: "ShopMart", from_addr: "orders@shopmart.example", subject: "Order #A83920 has shipped", category: "Shopping", ago: 14 * HOUR },
  { from_name: "Strava", from_addr: "no-reply@strava.com", subject: "You have 3 new kudos this week", category: "Fitness", ago: 20 * HOUR },
  { from_name: "Morning Brew", from_addr: "crew@morningbrew.example", subject: "☕ Markets shrug off the noise", category: "Newsletters", account: "Secondary", ago: DAY },
  { from_name: "SwiftShip", from_addr: "tracking@swiftship.example", subject: "Out for delivery: your parcel arrives today", category: "Shopping", ago: DAY + 4 * HOUR },
  { from_name: "FiberNet", from_addr: "invoices@fibernet.example", subject: "Payment reminder — bill due in 3 days", category: "Bills", ago: DAY + 9 * HOUR },
  { from_name: "CoinWallet", from_addr: "no-reply@coinwallet.example", subject: "Deposit confirmed: 0.15 BTC", category: "Finance", ago: 2 * DAY },
  { from_name: "Dana Meyer", from_addr: "dana@acme.example", subject: "Re: Q2 planning — notes from today", category: "Work", account: "Work", ago: 2 * DAY + 3 * HOUR },
  { from_name: "Staycation", from_addr: "reservations@staycation.example", subject: "Booking confirmed — Seaside Loft, 2 nights", category: "Travel", ago: 2 * DAY + 8 * HOUR },
  { from_name: "The Brief", from_addr: "editor@thebrief.example", subject: "Weekend reads: five links worth your time", category: "Newsletters", account: "Secondary", ago: 3 * DAY },
];
inbox.forEach(add);

// ---- bulk filler so the sidebar counts look lived-in ----
const brands: Record<string, [string, string][]> = {
  Work: [["GitHub", "notifications@github.com"], ["Jira", "jira@acme.example"], ["Slack", "notify@slack.com"], ["CI / Actions", "actions@github.com"], ["Dana Meyer", "dana@acme.example"], ["Sam Okafor", "sam@acme.example"]],
  Finance: [["Northbank", "alerts@northbank.example"], ["Brokerage", "statements@brokerage.example"], ["CoinWallet", "no-reply@coinwallet.example"]],
  Bills: [["PowerCo", "billing@power-co.example"], ["FiberNet", "invoices@fibernet.example"]],
  Shopping: [["ShopMart", "orders@shopmart.example"], ["SwiftShip", "tracking@swiftship.example"]],
  Travel: [["FlyAway", "bookings@flyaway.example"], ["Staycation", "reservations@staycation.example"]],
  Fitness: [["Strava", "no-reply@strava.com"], ["IronPeak Gym", "hello@ironpeak.example"]],
  Newsletters: [["Morning Brew", "crew@morningbrew.example"], ["The Brief", "editor@thebrief.example"]],
  Calendar: [["Dana Meyer", "dana@acme.example"], ["Sam Okafor", "sam@acme.example"]],
  Business: [["Tax Office", "no-reply@tax.example"]],
  Notifications: [["Apple", "no-reply@apple.com"], ["Service", "notify@notify.example"]],
  Muted: [["LinkedIn", "notify@linkedin.com"], ["Job Alerts", "alerts@jobalerts.example"]],
};
const subjectsBy: Record<string, string[]> = {
  Work: ["Deployment {n} is live", "Re: [acme/web] Release build (PR #{n})", "Weekly update for the platform team", "Incident {n}: resolved", "Standup notes — {n}", "Code review requested on WEB-{n}"],
  Finance: ["Monthly statement is ready", "Card payment of {n} processed", "Interest posted to your account", "Trade confirmation #{n}", "Your portfolio summary"],
  Bills: ["Invoice #{n} — amount due", "Your bill is ready to view", "Payment received, thank you", "Autopay scheduled for the {n}th", "Receipt for your payment"],
  Shopping: ["Order #{n} confirmed", "Your parcel is on the way", "Delivered: order #{n}", "Rate your recent purchase", "Back in stock: items you saved"],
  Travel: ["Your itinerary is ready", "Check-in is now open", "Booking reference #{n}", "Gate change for flight {n}", "Trip receipt — 2 nights"],
  Fitness: ["Your weekly activity summary", "New personal record 🎉", "Class booked for tomorrow 7am", "Membership renews next week", "3 new kudos"],
  Newsletters: ["The Monday brief", "Five links worth reading", "Issue #{n} is out", "This week in tech", "Deep dive: issue {n}"],
  Calendar: ["Invitation: Sprint review @ 2pm", "Invite: 1:1 with Dana", "Accepted: Planning sync", "Invitation: Design critique", "Invite: All-hands"],
  Business: ["Contract for signature", "Your tax document is available", "Quarterly filing reminder", "Contract renewal notice"],
  Notifications: ["Your receipt from Apple", "New sign-in to your account", "Password changed successfully", "Storage is almost full", "Your subscription renews soon"],
  Muted: ["You appeared in {n} searches", "New jobs matching your profile", "{n} people viewed your profile", "You have a new connection", "Trending in your network"],
};
const counts: Record<string, number> = { Work: 46, Finance: 24, Bills: 19, Shopping: 15, Travel: 17, Fitness: 12, Newsletters: 9, Calendar: 11, Business: 8, Notifications: 14, Muted: 28 };
const accountsPool = ["Personal", "Secondary", "Work"];

for (const [cat, n] of Object.entries(counts)) {
  const bs = brands[cat];
  const subs = subjectsBy[cat];
  for (let i = 0; i < n; i++) {
    const [name, addr] = bs[i % bs.length];
    const subj = subs[i % subs.length].replace("{n}", String(100 + ((i * 37) % 900)));
    add({
      from_name: name,
      from_addr: addr,
      subject: subj,
      category: cat,
      account: cat === "Work" ? "Work" : accountsPool[i % accountsPool.length],
      mailbox: "INBOX",
      ago: (3 + i) * DAY + (i % 12) * HOUR + i * 97,
      seen: i % 5 === 0 ? 0 : 1,
      done: i % 4 === 0 ? 1 : 0,
    });
  }
}

// ---- folders (drive the sidebar Folders section) ----
const folder = (mailbox: string, n: number) => {
  const pool = Object.values(brands).flat();
  for (let i = 0; i < n; i++) {
    const [name, addr] = pool[i % pool.length];
    add({ mailbox, from_name: name, from_addr: addr, subject: `Archived item ${i + 1}`, category: "Other", ago: (10 + i) * DAY, done: 1, account: accountsPool[i % 3] });
  }
};
folder("Sent", 22);
folder("Archived", 41);
folder("Spam", 13);
folder("Trash", 9);

const total = (db.query("SELECT COUNT(*) AS n FROM messages").get() as any).n;
db.close();
console.log(`seeded ${total} fictional messages → ${dbPath}`);
