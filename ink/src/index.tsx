// Entry point: alt-screen wrapper around the Ink app. Run from the repo root:
//   bun ink/src/index.tsx
import React from "react";
import { render } from "ink";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { App } from "./app.tsx";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dbPath = join(repoRoot, "spark-cli.db");
const cfgPath = join(repoRoot, "config.yaml");

for (const p of [dbPath, cfgPath, join(repoRoot, "spark-cli")]) {
  if (!existsSync(p)) {
    console.error(`missing ${p} — run from a repo with db, config.yaml and the Go binary built`);
    process.exit(1);
  }
}

// Alternate screen: full-screen app without polluting scrollback.
process.stdout.write("\x1b[?1049h\x1b[H");
const restore = () => process.stdout.write("\x1b[?1049l");
process.on("exit", restore);

// forceClear lets the app drop Ink's cached frame after a child process (the
// inline previewer) has painted over the screen, so the next render is full.
const holder: { clear: () => void } = { clear: () => {} };
const app = render(
  <App repoRoot={repoRoot} dbPath={dbPath} cfgPath={cfgPath} forceClear={() => holder.clear()} />,
  { exitOnCtrlC: true },
);
holder.clear = app.clear;
await app.waitUntilExit();
restore();
