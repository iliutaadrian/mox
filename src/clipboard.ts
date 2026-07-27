// System clipboard write. The TUI owns the terminal, so shelling out to the
// platform clipboard tool is the only reliable path (OSC 52 depends on the
// terminal emulator allowing it). First tool that exists wins.
import { spawnSync } from "node:child_process";

const CANDIDATES: { cmd: string; args: string[] }[] =
  process.platform === "darwin"
    ? [{ cmd: "pbcopy", args: [] }]
    : [
        { cmd: "wl-copy", args: [] },
        { cmd: "xclip", args: ["-selection", "clipboard"] },
        { cmd: "xsel", args: ["--clipboard", "--input"] },
      ];

/** copyToClipboard writes text to the system clipboard. Returns the failure
 * reason instead of throwing — callers surface it on the status line. */
export function copyToClipboard(text: string): { ok: boolean; error: string } {
  for (const { cmd, args } of CANDIDATES) {
    const r = spawnSync(cmd, args, { input: text, encoding: "utf8" });
    // ENOENT (tool not installed) → try the next candidate; a real non-zero
    // exit is reported, since the tool ran and refused.
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") continue;
    if (r.error) return { ok: false, error: r.error.message };
    if (r.status === 0) return { ok: true, error: "" };
    return { ok: false, error: (r.stderr || "").trim() || `${cmd} exited ${r.status}` };
  }
  return { ok: false, error: `no clipboard tool found (${CANDIDATES.map((c) => c.cmd).join(", ")})` };
}
