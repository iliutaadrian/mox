#!/usr/bin/env -S bun --preload @opentui/solid/preload
// Entry point: OpenTUI (Solid) app. OpenTUI's native renderer owns the alt
// screen, synchronized output and mouse — no manual escape juggling here.
//   dev:        bun src/index.tsx           (uses ./config.yaml at the repo root)
//   installed:  mox                         (uses ~/Documents/mox/config.yaml)
import { render } from "@opentui/solid";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";

import { App } from "./app.tsx";
import { Store } from "./db.ts";
import { loadConfig } from "./config.ts";
import { prefill, reclassifyAll } from "./engine.ts";
import { DATA_DIR, resolveCfgPath, resolveDbPath } from "./paths.ts";
import pkg from "../package.json";

const args = process.argv.slice(2);

// `mox --version` / `-v`: print the build version and exit. No config needed.
if (args.includes("--version") || args.includes("-v")) {
  console.log(`mox ${pkg.version}`);
  process.exit(0);
}

// `mox --help` / `-h`: print usage and exit. Must be handled before anything
// else — otherwise an unrecognized flag falls through and boots the TUI.
if (args.includes("--help") || args.includes("-h")) {
  console.log(`mox ${pkg.version} — a fast, local, rule-based terminal email client

usage:
  mox                    launch the TUI (default)
  mox --reclassify       file the inbox against the current config rules
                         (manual moves kept), then exit
  mox --prefill          one-time seed: metadata for the whole inbox + full
                         bodies for offline_categories, then exit
  mox --stats            print a snapshot of the local store, then exit
  mox upgrade            download + install the latest release in place
  mox --version, -v      print the version and exit
  mox --help, -h         print this help and exit

config + database live in ~/Documents/mox (override with $MOX_CONFIG / $MOX_DB).`);
  process.exit(0);
}

// `mox upgrade`: re-run the canonical installer, targeting the directory of the
// currently-running binary — so it downloads the latest release and overwrites
// this executable in place. Only meaningful for the compiled binary; when run
// from source, process.execPath is the Bun interpreter, so we bail with advice.
if (args[0] === "upgrade") {
  const exe = process.execPath;
  if (basename(exe) === "bun") {
    console.error("`mox upgrade` only works on the installed binary.\nRunning from source — update with: git pull && bun run build");
    process.exit(1);
  }
  const dir = dirname(exe);
  console.log(`upgrading mox in ${dir} (current: ${pkg.version})…`);
  const r = spawnSync(
    "bash",
    ["-c", "curl -fsSL https://raw.githubusercontent.com/iliutaadrian/mox/main/install.sh | bash"],
    { stdio: "inherit", env: { ...process.env, MOX_INSTALL_DIR: dir } },
  );
  process.exit(r.status ?? 1);
}

// Safety net: a background IMAP socket error (idle connection dropped by the
// server) must never crash the TUI. Handlers on each client already evict dead
// connections; this catches anything that slips through so the app keeps
// running and the next refresh reconnects.
process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});

// Locate config + db (shared with cli.ts / mcp.ts). Installed builds keep both
// in ~/Documents/mox; running from source uses the repo root. See ./paths.ts.
const cfgPath = resolveCfgPath();
const dbPath = resolveDbPath(cfgPath);

if (!existsSync(cfgPath)) {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(dirname(cfgPath), { recursive: true });
  console.error(
    `no config found — create ${cfgPath} (copy config.example.yaml and edit),\n` +
      `or set $MOX_CONFIG to your config path.`,
  );
  process.exit(1);
}
// dbPath is created on first run if absent.

// `mox --reclassify`: re-apply the current config rules to every INBOX message
// (manual moves preserved), without fetching. Use after editing categories in
// config.yaml — adding a domain/word files matching mail; removing one drops the
// now-unmatched mail back to Uncategorized. No network, no config beyond load.
if (args.includes("--reclassify")) {
  const store = new Store(dbPath);
  const cfg = loadConfig(cfgPath);
  const { filed, unfiled, scanned } = reclassifyAll(store, cfg);
  store.close();
  console.log(`reclassified ${scanned} inbox messages: ${filed} filed, ${unfiled} back to Uncategorized`);
  process.exit(0);
}

// `mox --stats`: print a read-only snapshot of DOWNLOADED mail (rows with a
// cached body/html — what's readable offline), broken down by category,
// account/mailbox and top senders, then exit. No network.
if (args.includes("--stats")) {
  const store = new Store(dbPath);
  const C = { dim: "\x1b[2m", green: "\x1b[32m", cyan: "\x1b[36m", bold: "\x1b[1m", off: "\x1b[0m" };
  const tty = process.stdout.isTTY;
  const paint = (s: string, c: string) => (tty ? `${c}${s}${C.off}` : s);
  const num = (n: number) => n.toLocaleString("en-US");
  const w = (s: string) => process.stdout.write(s);

  const s = store.downloadStats();
  store.close();

  // Right-align counts in a column as wide as the largest download count.
  const maxN = Math.max(s.downloaded, 1);
  const pad = (n: number) => num(n).padStart(num(maxN).length);
  const row = (label: string, n: number, extra = "") =>
    w(`      ${paint(pad(n), C.bold)}  ${label}${extra ? paint(`  ${extra}`, C.dim) : ""}\n`);
  const section = (title: string, rows: { key: string; n: number }[]) => {
    w(`\n  ${paint(title, C.cyan)}\n`);
    if (!rows.length) w(`      ${paint("none", C.dim)}\n`);
    for (const r of rows) row(r.key, r.n);
  };

  const pct = s.total ? ((s.downloaded / s.total) * 100).toFixed(1) : "0.0";
  const htmlPct = s.downloaded ? ((s.withHtml / s.downloaded) * 100).toFixed(0) : "0";
  w(`\n  ${paint("mox", C.bold)} ${paint("· stats · downloaded mail", C.dim)}\n\n`);
  w(`  ${paint("overview", C.cyan)}\n`);
  row("downloaded", s.downloaded, `${pct}% of ${num(s.total)} total`);
  row("with html", s.withHtml, `${htmlPct}% of downloaded`);

  section("downloaded by category", s.byCategory);
  section("downloaded by mailbox", s.byMailbox);
  section(`top ${s.bySender.length} senders`, s.bySender);
  w("\n");
  process.exit(0);
}

// `mox --prefill`: one-time headless bulk seed — sweep envelope-only metadata
// over the whole INBOX (searchable offline) and cache full bodies for the
// offline categories, then exit. Normal launch fetches only `fetch_limit`.
if (args.includes("--prefill")) {
  const store = new Store(dbPath);
  const cfg = loadConfig(cfgPath);

  // Tiny ANSI helpers + progress bar — this path only runs in a real terminal.
  const C = { dim: "\x1b[2m", green: "\x1b[32m", cyan: "\x1b[36m", bold: "\x1b[1m", red: "\x1b[31m", yellow: "\x1b[33m", off: "\x1b[0m" };
  const tty = process.stdout.isTTY;
  const paint = (s: string, c: string) => (tty ? `${c}${s}${C.off}` : s);
  const num = (n: number) => n.toLocaleString("en-US");
  const bar = (done: number, total: number, w = 24) => {
    const filled = total > 0 ? Math.round((done / total) * w) : w;
    return "█".repeat(filled) + "░".repeat(Math.max(0, w - filled));
  };
  const cats = cfg.offlineCategories;
  const w = (s: string) => process.stdout.write(s);

  w(`\n  ${paint("mox", C.bold)} ${paint("· prefill", C.dim)}\n\n`);
  w(`  ${paint("⟳", C.cyan)} syncing ${cfg.accounts.length} account${cfg.accounts.length === 1 ? "" : "s"} ${paint("(all folders + full inbox index)", C.dim)}…\n\n`);

  // Live per-account status block, repainted in place. Accounts sync
  // concurrently, so each keeps its own line; events arrive interleaved.
  type St = { label: string; done: number; total: number; status: "waiting" | "sync" | "done" | "failed"; inserted: number; loggedPhase: string };
  const state = new Map<string, St>(
    cfg.accounts.map((a) => [a.name, { label: "waiting…", done: 0, total: 0, status: "waiting", inserted: 0, loggedPhase: "" }]),
  );
  const nameW = Math.max(...cfg.accounts.map((a) => a.name.length));
  const phaseLabel: Record<string, string> = { full: "bodies", sweep: "index", new: "new mail" };
  const fmtLine = (name: string, st: St): string => {
    const label = paint(name.padEnd(nameW), C.bold);
    if (st.status === "waiting") return `    ${label}  ${paint("waiting…", C.dim)}`;
    if (st.status === "failed") return `    ${label}  ${paint("✗ incomplete", C.red)} ${paint("(re-run to finish)", C.dim)}`;
    if (st.status === "done") return `    ${label}  ${paint("✓ done", C.green)} ${paint(`${num(st.inserted)} new`, C.dim)}`;
    const b = paint(bar(st.done, st.total, 16), C.cyan);
    return `    ${label}  ${(phaseLabel[st.label] ?? st.label).padEnd(8)} [${b}] ${num(st.done)}/${num(st.total)}`;
  };
  let painted = 0;
  const repaint = () => {
    if (!tty) return;
    if (painted) w(`\x1b[${painted}A`); // cursor up to the first status line
    for (const a of cfg.accounts) w(`\r\x1b[2K${fmtLine(a.name, state.get(a.name)!)}\n`);
    painted = cfg.accounts.length;
  };
  repaint(); // initial "waiting…" block

  const { fetched, filed, cached, failed } = await prefill(store, cfg, {
    onSync: (ev) => {
      const st = state.get(ev.account);
      if (!st) return;
      if (ev.phase === "done") {
        st.status = "done";
        st.inserted = ev.done;
      } else if (ev.phase === "failed") {
        st.status = "failed";
      } else {
        st.status = "sync";
        st.label = ev.phase;
        st.done = ev.done;
        st.total = ev.total;
      }
      if (tty) {
        repaint();
      } else if (ev.phase === "done") {
        w(`  ${ev.account}: done ${num(ev.done)} new\n`);
      } else if (ev.phase === "failed") {
        w(`  ${ev.account}: INCOMPLETE — connection dropped, re-run to finish\n`);
      } else if (st.loggedPhase !== ev.phase) {
        // One line per phase transition — enough signal for piped/headless logs
        // without spamming a line per batch.
        st.loggedPhase = ev.phase;
        w(`  ${ev.account}: ${phaseLabel[ev.phase] ?? ev.phase} (${num(ev.total)})\n`);
      }
    },
    onSynced: (f, fl) => {
      w(`\n  ${paint("✓", C.green)} fetched ${paint(num(f), C.bold)} ${paint("·", C.dim)} filed ${paint(num(fl), C.bold)} by rules\n\n`);
      if (cats.length) w(`  ${paint("⟳", C.cyan)} caching offline bodies ${paint(`(${cats.join(", ")})`, C.dim)}\n`);
      else w(`  ${paint("·", C.dim)} no ${paint("offline_categories", C.dim)} set — skipping body cache\n`);
    },
    onCache: (done, total) => {
      if (tty) w(`\r    [${paint(bar(done, total), C.cyan)}] ${num(done)}/${num(total)}   `);
    },
  });
  if (cats.length && tty) w("\n");

  store.close();
  const ok = failed.length === 0;
  w(
    ok
      ? `\n  ${paint("✓ prefill complete", C.green)}\n`
      : `\n  ${paint("⚠ prefill INCOMPLETE", C.yellow)} ${paint(`— ${failed.join(", ")} dropped mid-sync`, C.dim)}\n`,
  );
  w(`      ${paint("fetched", C.dim)}  ${num(fetched)}\n`);
  w(`      ${paint("filed", C.dim)}    ${num(filed)}\n`);
  w(`      ${paint("cached", C.dim)}   ${num(cached)}${cats.length ? paint(`  offline: ${cats.join(", ")}`, C.dim) : ""}\n`);
  if (!ok) w(`\n  ${paint("→ run", C.dim)} ${paint("mox --prefill", C.bold)} ${paint("again to finish (it resumes where it stopped)", C.dim)}\n`);
  w("\n");
  process.exit(failed.length ? 1 : 0);
}

await render(() => <App dbPath={dbPath} cfgPath={cfgPath} />, { exitOnCtrlC: true });
