#!/usr/bin/env -S bun --preload @opentui/solid/preload
// Entry point: OpenTUI (Solid) app. OpenTUI's native renderer owns the alt
// screen, synchronized output and mouse — no manual escape juggling here.
//   dev:        bun src/index.tsx           (uses ./config.yaml at the repo root)
//   installed:  mox                         (uses ~/.config/mox/config.yaml)
import { render } from "@opentui/solid";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { App } from "./app.tsx";

// Safety net: a background IMAP socket error (idle connection dropped by the
// server) must never crash the TUI. Handlers on each client already evict dead
// connections; this catches anything that slips through so the app keeps
// running and the next refresh reconnects.
process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});

// Locate config.yaml: $MOX_CONFIG, then the repo root (dev), then the standard
// per-user location. The SQLite store lives next to it ($MOX_DB overrides).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const xdgConfig = join(homedir(), ".config", "mox", "config.yaml");
const cfgPath =
  [process.env.MOX_CONFIG, join(repoRoot, "config.yaml"), xdgConfig].find((p) => p && existsSync(p)) ?? xdgConfig;
const dbPath = process.env.MOX_DB ?? join(dirname(cfgPath), "mox.db");

if (!existsSync(cfgPath)) {
  mkdirSync(dirname(xdgConfig), { recursive: true });
  console.error(
    `no config found — create ${xdgConfig} (copy config.example.yaml and edit),\n` +
      `or set $MOX_CONFIG to your config path.`,
  );
  process.exit(1);
}
// dbPath is created on first run if absent.

await render(() => <App dbPath={dbPath} cfgPath={cfgPath} />, { exitOnCtrlC: true });
