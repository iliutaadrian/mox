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
import { prefill } from "./engine.ts";
import { DATA_DIR, resolveCfgPath, resolveDbPath } from "./paths.ts";
import pkg from "../package.json";

const args = process.argv.slice(2);

// `mox --version` / `-v`: print the build version and exit. No config needed.
if (args.includes("--version") || args.includes("-v")) {
  console.log(`mox ${pkg.version}`);
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

// `mox --prefill`: one-time headless bulk seed — sweep envelope-only metadata
// over the whole INBOX (searchable offline) and cache full bodies for the
// offline categories, then exit. Normal launch fetches only `fetch_limit`.
if (args.includes("--prefill")) {
  const store = new Store(dbPath);
  const cfg = loadConfig(cfgPath);

  // Tiny ANSI helpers + progress bar — this path only runs in a real terminal.
  const C = { dim: "\x1b[2m", green: "\x1b[32m", cyan: "\x1b[36m", bold: "\x1b[1m", off: "\x1b[0m" };
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
  w(`  ${paint("⟳", C.cyan)} syncing ${cfg.accounts.length} account${cfg.accounts.length === 1 ? "" : "s"} ${paint("(all folders + full inbox index)", C.dim)}…\n`);

  const { fetched, filed, cached } = await prefill(store, cfg, {
    onSynced: (f, fl) => {
      w(`  ${paint("✓", C.green)} fetched ${paint(num(f), C.bold)} ${paint("·", C.dim)} filed ${paint(num(fl), C.bold)} by rules\n\n`);
      if (cats.length) w(`  ${paint("⟳", C.cyan)} caching offline bodies ${paint(`(${cats.join(", ")})`, C.dim)}\n`);
      else w(`  ${paint("·", C.dim)} no ${paint("offline_categories", C.dim)} set — skipping body cache\n`);
    },
    onCache: (done, total) => {
      if (tty) w(`\r    [${paint(bar(done, total), C.cyan)}] ${num(done)}/${num(total)}   `);
    },
  });
  if (cats.length && tty) w("\n");

  store.close();
  w(`\n  ${paint("✓ prefill complete", C.green)}\n`);
  w(`      ${paint("fetched", C.dim)}  ${num(fetched)}\n`);
  w(`      ${paint("filed", C.dim)}    ${num(filed)}\n`);
  w(`      ${paint("cached", C.dim)}   ${num(cached)}${cats.length ? paint(`  offline: ${cats.join(", ")}`, C.dim) : ""}\n\n`);
  process.exit(0);
}

await render(() => <App dbPath={dbPath} cfgPath={cfgPath} />, { exitOnCtrlC: true });
