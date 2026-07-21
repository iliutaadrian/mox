// Entry point: alt-screen wrapper around the Ink app.
//   dev:        bun ink/src/index.tsx      (uses ./config.yaml at the repo root)
//   installed:  spark                      (uses ~/.config/spark-cli/config.yaml)
import React from "react";
import { render } from "ink";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { App } from "./app.tsx";

// Locate config.yaml: $SPARK_CONFIG, then the repo root (dev), then the standard
// per-user location. The SQLite store lives next to it ($SPARK_DB overrides).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const xdgConfig = join(homedir(), ".config", "spark-cli", "config.yaml");
const cfgPath =
  [process.env.SPARK_CONFIG, join(repoRoot, "config.yaml"), xdgConfig].find((p) => p && existsSync(p)) ?? xdgConfig;
const dbPath = process.env.SPARK_DB ?? join(dirname(cfgPath), "spark-cli.db");

if (!existsSync(cfgPath)) {
  mkdirSync(dirname(xdgConfig), { recursive: true });
  console.error(
    `no config found — create ${xdgConfig} (copy config.example.yaml and edit),\n` +
      `or set $SPARK_CONFIG to your config path.`,
  );
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

const app = render(<App dbPath={dbPath} cfgPath={cfgPath} />, { exitOnCtrlC: true });
await app.waitUntilExit();
restore();
