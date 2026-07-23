#!/usr/bin/env -S bun --preload @opentui/solid/preload
// Entry point: OpenTUI (Solid) app. OpenTUI's native renderer owns the alt
// screen, synchronized output and mouse — no manual escape juggling here.
//   dev:        bun src/index.tsx           (uses ./config.yaml at the repo root)
//   installed:  mox                         (uses ~/Documents/mox/config.yaml)
import { render } from "@opentui/solid";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { App } from "./app.tsx";
import { DATA_DIR, resolveCfgPath, resolveDbPath } from "./paths.ts";

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

await render(() => <App dbPath={dbPath} cfgPath={cfgPath} />, { exitOnCtrlC: true });
