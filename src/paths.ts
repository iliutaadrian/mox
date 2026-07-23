// Single source of truth for where config + the SQLite store live, shared by
// the TUI (index.tsx), the headless CLI (cli.ts) and the MCP server (mcp.ts).
//
// Resolution order:
//   config  →  $MOX_CONFIG  |  repo ./config.yaml (dev)  |  ~/Documents/mox/config.yaml (installed)
//   db      →  $MOX_DB      |  repo ./mox.db when running from source (dev)  |  ~/Documents/mox/mox.db (installed)
//
// The installed binary keeps everything — config, database, downloaded
// attachments — in one visible folder: ~/Documents/mox. Running from source
// keeps using the repo root so development never touches your real mailbox.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const DATA_DIR = join(homedir(), "Documents", "mox");

// A compiled standalone binary reports its own path as import.meta.url; only a
// checkout has a real ./config.yaml at the repo root next to src/.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoConfig = join(repoRoot, "config.yaml");

export function resolveCfgPath(): string {
  if (process.env.MOX_CONFIG) return process.env.MOX_CONFIG;
  if (existsSync(repoConfig)) return repoConfig; // dev
  return join(DATA_DIR, "config.yaml"); // installed
}

export function resolveDbPath(cfgPath: string): string {
  if (process.env.MOX_DB) return process.env.MOX_DB;
  // Dev checkout: db sits next to the repo config, as before.
  if (cfgPath === repoConfig) return join(repoRoot, "mox.db");
  // Installed: always the shared data dir, regardless of config location.
  return join(DATA_DIR, "mox.db");
}
