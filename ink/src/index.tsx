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

if (!existsSync(cfgPath)) {
  console.error(`missing ${cfgPath} — copy config.example.yaml to config.yaml and edit`);
  process.exit(1);
}
// dbPath is created on first run if absent.

// Alternate screen: full-screen app without polluting scrollback.
process.stdout.write("\x1b[?1049h\x1b[H");
const restore = () => process.stdout.write("\x1b[?1049l");
process.on("exit", restore);

// Synchronized output (DEC 2026): Ink writes a whole frame in one write() call,
// so bracketing each write makes the terminal buffer it and swap atomically —
// no partial repaints / tearing / flicker while scrolling. Terminals that don't
// support it ignore the escapes. We skip our own escape writes (alt-screen,
// mouse) so we don't double-wrap them.
const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";
const realWrite = process.stdout.write.bind(process.stdout);
(process.stdout as any).write = (chunk: any, ...rest: any[]) => {
  if (typeof chunk === "string" && chunk.length > 2 && !chunk.startsWith("\x1b[?")) {
    return realWrite(BSU + chunk + ESU, ...rest);
  }
  return realWrite(chunk, ...rest);
};

// forceClear lets the app drop Ink's cached frame after a child process (the
// inline previewer) has painted over the screen, so the next render is full.
const holder: { clear: () => void } = { clear: () => {} };
const app = render(
  <App dbPath={dbPath} cfgPath={cfgPath} forceClear={() => holder.clear()} />,
  { exitOnCtrlC: true },
);
holder.clear = app.clear;
await app.waitUntilExit();
restore();
