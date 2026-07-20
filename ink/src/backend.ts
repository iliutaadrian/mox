// Every mutation goes through the Go binary — one writer implementation, the
// battle-tested one (Yahoo quirks, IMAP grouping, config handling live there).
import { spawn } from "node:child_process";

export type BackendResult = { ok: boolean; out: string };

function run(args: string[], cwd: string): Promise<BackendResult> {
  return new Promise((resolve) => {
    const p = spawn("./spark-cli", args, { cwd });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) =>
      resolve({ ok: code === 0, out: (code === 0 ? out : err).trim() }),
    );
    p.on("error", (e) => resolve({ ok: false, out: String(e) }));
  });
}

export const backend = (repoRoot: string) => ({
  sync: () => run(["-sync"], repoRoot),
  mark: (ids: number[], seen: boolean) =>
    run(["-mark", seen ? "read" : "unread", "-ids", ids.join(",")], repoRoot),
  move: (ids: number[], category: string) =>
    run(["-move", category, "-ids", ids.join(",")], repoRoot),
});
