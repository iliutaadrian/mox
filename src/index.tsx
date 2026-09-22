#!/usr/bin/env -S bun --preload @opentui/solid/preload
// Entry point: OpenTUI (Solid) app. OpenTUI's native renderer owns the alt
// screen, synchronized output and mouse — no manual escape juggling here.
//   dev:        bun src/index.tsx           (uses ./config.yaml at the repo root)
//   installed:  mox                         (uses ~/Documents/mox/config.yaml)
import { existsSync, mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";

import { maybeBackup } from "./backup.ts";
import { Store } from "./db.ts";
import { notify } from "./notify.ts";
import { codesEnabled, copyArrivedCode } from "./autocopy.ts";
import { type Config, loadConfig } from "./config.ts";
import { prefill, reclassifyAll } from "./engine.ts";
import { DATA_DIR, resolveCfgPath, resolveDbPath } from "./paths.ts";
import pkg from "../package.json";

const args = process.argv.slice(2);

// Safety net for the interactive and one-shot commands: a background IMAP socket
// error (idle connection dropped by the server) must never tear down the TUI or
// abort a half-finished `--prefill`. Handlers on each client already evict dead
// connections; this catches anything that slips through so the app keeps running
// and the next refresh reconnects.
//
// Every path EXCEPT `mox mcp` deliberately. Installed there too it also swallowed
// the MCP server's startup errors, so `mox mcp` with a malformed config exited 0
// printing nothing and Claude Code saw a silently dead server.
if (args[0] !== "mcp") {
  process.on("uncaughtException", () => {});
  process.on("unhandledRejection", () => {});
}

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
  mox --notify-test      fire a sample login-code banner, report what was
                         tried, then exit
  mox --code-demo        inject a fake 2FA email, run the real arrival path
                         (detect + copy + notify), remove it, then exit
  mox --headless         sync forever with no TUI (also via headless: true in
                         config.yaml); runs until killed
  mox upgrade            download + install the latest release in place
  mox --version, -v      print the version and exit
  mox --help, -h         print this help and exit
  mox mcp                serve MCP on stdio (for Claude Code), then exit on EOF

config + database live in ~/Documents/mox (override with data_dir in config.yaml,
or $MOX_CONFIG / $MOX_DB).`);
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

// Locate config + db (shared with mcp.ts). Installed builds keep both
// in ~/Documents/mox; running from source uses the repo root. See ./paths.ts.
const cfgPath = resolveCfgPath();

if (!existsSync(cfgPath)) {
  // Best-effort: create the folders so the user has somewhere to drop the config.
  // An unwritable path (read-only volume, $MOX_CONFIG pointing somewhere absurd)
  // must still reach the message below rather than dying on a mkdir stack trace.
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    mkdirSync(dirname(cfgPath), { recursive: true });
  } catch {}
  console.error(
    `no config found — create ${cfgPath} (copy config.example.yaml and edit),\n` +
      `or set $MOX_CONFIG to your config path.`,
  );
  process.exit(1);
}

// The config decides where the database lives (`data_dir`), so it has to be read
// before the path — and a malformed one must report a readable line rather than
// a stack trace through the minified bundle, on every entry point including the
// `mox mcp` stream, where only stderr and the exit code reach Claude Code.
let bootCfg: Config;
try {
  bootCfg = loadConfig(cfgPath);
} catch (e) {
  console.error(`mox: cannot read ${cfgPath} — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
const dbPath = resolveDbPath(cfgPath, bootCfg);
// dbPath is created on first run if absent — but only inside a folder that
// exists, and a data_dir pointing somewhere new is exactly the case where it
// does not. Best-effort: an unwritable path still fails later with SQLite's own
// message, which names the path.
if (bootCfg.dataDir) {
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch {}
}

// Snapshot the store before anything starts writing to it (see ./backup.ts).
// No-op unless one is due, and best-effort: a full disk or an unwritable folder
// is reported and then ignored — it must never keep a command from running.
// EVERY entry point that writes goes through here: the TUI, `mox mcp` (which
// triages through the same backend()), `--reclassify` and `--prefill`. The
// read-only `--stats` is the one command that does not need it. Warnings go to
// stderr, so the MCP protocol stream on stdout stays clean.
function startBackups(cfg: Config = bootCfg): void {
  const first = maybeBackup(dbPath, cfg);
  if (first.error) console.warn(`mox: backup skipped — ${first.error}`);

  // A session can stay open for days, so re-check on a long interval too;
  // maybeBackup returns immediately until the schedule comes due. unref so the
  // timer never holds the process open — the one-shot commands exit regardless.
  setInterval(() => maybeBackup(dbPath, cfg), 60 * 60 * 1000).unref();
}

// `mox --notify-test`: fire the same banner an auto-copied code fires, and say
// which delivery paths were used. Exists because the macOS fallback (osascript)
// exits 0 even when the notification is silently dropped, so "it ran" and "you
// saw it" are different questions and only a human can answer the second.
if (args.includes("--notify-test")) {
  const used = notify("mox", "735470 copied · autentificare.spatiuprivat@anaf.ro");
  console.log(`tried: ${used.join(", ") || "nothing (no delivery path available)"}`);
  console.log(
    "No banner? A terminal usually suppresses its own OSC notification while its window is FOCUSED —\n" +
      "switch to another app and run this again. If it is still silent, check System Settings →\n" +
      "Notifications for your terminal (and for Script Editor, which is what plain osascript shows as),\n" +
      "or `brew install terminal-notifier`, which mox prefers when it is present.",
  );
  process.exit(0);
}

// `mox --code-demo`: prove the whole auto-copy chain without waiting for a real
// 2FA mail. A synthetic message is inserted into the local store, the SAME
// function the TUI's sync calls picks it up, and the row is removed again in a
// finally — the store is left exactly as it was found.
if (args.includes("--code-demo")) {
  const cfg = bootCfg;
  const store = new Store(dbPath);
  const marker = store.maxMessageId();
  const uid = Date.now();
  let injectedId = 0;
  try {
    const subject = "Cod de siguranta";
    const from = "autentificare.spatiuprivat@anaf.ro";
    // The code is generated, not fixed, so a demo run can never hand you a
    // stale number that looks like a real one.
    const code = String(Math.floor(100000 + Math.random() * 900000));
    store.insertMessage({
      account: "code-demo",
      mailbox: "INBOX",
      uid,
      messageId: `<code-demo-${uid}@mox.local>`,
      fromAddr: from,
      fromName: "ANAF",
      subject,
      date: Math.floor(Date.now() / 1000),
      snippet: "",
      body: `Cod de siguranta: ${code}, expira dupa 300 secunde.`,
      html: "",
      attachments: [],
      seen: false,
    });
    injectedId = store.messageIdOf("code-demo", "INBOX", uid);
    console.log(`injected: "${subject}" from ${from}`);
    if (!codesEnabled(cfg)) {
      console.log("detected: — login codes are off (set login_codes: true in config.yaml)");
    } else {
      const hit = copyArrivedCode(store, cfg, marker);
      if (!hit) {
        console.log("detected: nothing — the shipped word lists did not claim it (login_codes_auto_copy off?)");
      } else {
        console.log(`detected: ${hit.code} [${hit.word}/${hit.source}]`);
        console.log(`copied:   ${hit.copied ? "clipboard ok" : `FAILED — ${hit.error}`}`);
        console.log(`notified: ${hit.notified.join(", ") || "off (login_codes_notify: false)"}`);
        if (hit.copied) console.log(`\nPaste anywhere to confirm — it should read ${hit.code}.`);
      }
    }
  } finally {
    // Whatever happened above, the fake mail does not outlive this command —
    // and only ever that one row: a sync running in another window may have
    // inserted real mail since the marker was taken.
    if (injectedId) {
      store.deleteByIds([injectedId]);
      console.log(`\ncleaned up: removed the injected row (id ${injectedId})`);
    }
    store.close();
  }
  process.exit(0);
}

// `mox --reclassify`: re-apply the current config rules to every INBOX message
// (manual moves preserved), without fetching. Use after editing categories in
// config.yaml — adding a domain/word files matching mail; removing one drops the
// now-unmatched mail back to Uncategorized. No network, no config beyond load.
if (args.includes("--reclassify")) {
  const cfg = bootCfg;
  startBackups(cfg);
  const store = new Store(dbPath);
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
  const cfg = bootCfg;
  startBackups(cfg);
  const store = new Store(dbPath);

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

// Headless daemon: `headless: true` in config.yaml (or `mox --headless`) runs
// the same sync the TUI runs on its timer, forever, with no terminal — for a
// server that should keep the local store current with no one attached. It
// never exits on its own: stop it with Ctrl-C or `kill`. `mox mcp` keeps its
// own path, so a headless config still serves MCP normally.
if (args[0] !== "mcp" && (args.includes("--headless") || bootCfg.headless)) {
  const cfg = bootCfg;
  startBackups(cfg);
  const store = new Store(dbPath);
  const { backend } = await import("./backend.ts");
  const be = backend(store, cfg);

  const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
  const log = (s: string) => process.stdout.write(`${stamp()}  ${s}\n`);

  // One clean shutdown path for both signals: close the store (checkpoints the
  // WAL) so the database a later TUI or `--stats` opens is never mid-write.
  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig} — stopping`);
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log(`mox ${pkg.version} headless — ${cfg.accounts.length} account(s), every ${cfg.headlessEverySeconds}s`);
  log(`db ${dbPath}`);

  // Sequential loop rather than setInterval: a sync slower than the interval
  // must delay the next one, never stack a second concurrent IMAP pass.
  while (!stopping) {
    const t0 = Date.now();
    const r = await be.sync();
    const ms = Date.now() - t0;
    // Quiet by default — a line only when mail actually moved or a sync failed,
    // so a log left running for weeks stays readable.
    if (!r.ok) log(`sync failed — ${r.out}`);
    else if ((r.out.match(/\d+/g) ?? []).some((n) => Number(n) > 0)) log(`${r.out} (${ms}ms)`);
    await new Promise((res) => setTimeout(res, cfg.headlessEverySeconds * 1000));
  }
}

// `mox mcp`: serve the MCP tools over stdio. mcp.ts is its own entry file, so a
// dev checkout can run it straight with Bun — but an installed binary has no
// source tree to point Claude Code at, so route it here as well. The import
// specifier is a literal, so the bundler follows it into the standalone build.
//
// mcp.ts stays alive on its stdin listener, which is why the TUI startup sits in
// the else branch: falling through would paint the interface over a live
// protocol stream. Nothing may write to stdout before the handoff, which is why
// the renderer and the interface are imported inside that branch rather than at
// the top of this file — on the MCP path no terminal code is ever loaded.
if (args[0] === "mcp") {
  // Startup failures here reach a machine, not a terminal: Claude Code sees only
  // the exit code and stderr. Report one readable line and a non-zero exit
  // instead of a stack trace through the minified bundle. loadConfig runs inside
  // the same try, so a malformed config fails the same readable way.
  try {
    startBackups();
    await import("./mcp.ts");
  } catch (e) {
    console.error(`mox mcp: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
} else {
  startBackups();

  // Literal specifiers, so the bundler still follows both into the standalone build.
  const { render } = await import("@opentui/solid");
  const { App } = await import("./app.tsx");
  await render(() => <App dbPath={dbPath} cfgPath={cfgPath} />, { exitOnCtrlC: true });
}
