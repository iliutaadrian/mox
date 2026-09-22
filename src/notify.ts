// Desktop notification. An auto-copied login code lands while you are looking
// at a browser, not at mox, so the status line would never be read — the banner
// is the only signal that reaches you there.
//
// Three delivery paths, tried in order, because on macOS the obvious one is the
// least reliable:
//   1. OSC 777 — the TERMINAL posts the notification. No permission of our own
//      (it is attributed to the terminal, which the user already granted), and
//      it survives a compiled binary with no bundle id. Wrapped for tmux, which
//      otherwise swallows an unknown escape (needs `allow-passthrough on`).
//      Terminals commonly suppress it while their window is FOCUSED — which is
//      exactly when you don't need it.
//   2. terminal-notifier — a real bundle id, shows regardless of focus. Not
//      installed by default; used when present.
//   3. osascript / notify-send — the fallback. `osascript` exits 0 even when
//      the notification is silently dropped (Script Editor not allowed to
//      notify), so its success tells us nothing; it is tried last for that
//      reason, and `mox --notify-test` exists because of it.
//
// Fire-and-forget: a missing notifier is never worth an error on the status
// line when the clipboard write — the part that matters — already succeeded.
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

/** notify shows a desktop banner. Returns the paths it managed to use, for
 * `--notify-test`; callers on the hot path ignore it. */
export function notify(title: string, body: string): string[] {
  const used: string[] = [];
  if (osc777(title, body)) used.push("osc777");
  if (have("terminal-notifier")) {
    run("terminal-notifier", ["-title", title, "-message", body]);
    used.push("terminal-notifier");
  } else if (process.platform === "darwin") {
    // Both strings go through AppleScript source as escaped literals in a
    // single -e program — never interpolated into a shell command.
    run("osascript", ["-e", `display notification ${quote(body)} with title ${quote(title)}`]);
    used.push("osascript");
  } else {
    run("notify-send", [title, body]);
    used.push("notify-send");
  }
  return used;
}

// ESC ] 777 ; notify ; TITLE ; BODY BEL, written to the controlling terminal.
// Inside tmux it must be wrapped in a DCS passthrough with every ESC doubled,
// or tmux eats it.
function osc777(title: string, body: string): boolean {
  const clean = (s: string) => s.replace(/[\x00-\x1f;]/g, " ");
  const seq = `\x1b]777;notify;${clean(title)};${clean(body)}\x07`;
  const payload = process.env.TMUX ? `\x1bPtmux;${seq.replaceAll("\x1b", "\x1b\x1b")}\x1b\\` : seq;
  try {
    writeFileSync("/dev/tty", payload);
    return true;
  } catch {
    return false; // no controlling terminal (headless, piped, a test runner)
  }
}

function have(cmd: string): boolean {
  return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
}

// An unhandled "error" event on a child process throws, and a machine without
// the notifier is a normal state here — swallow it.
function run(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

// AppleScript string literal: backslashes first, then quotes; a newline would
// end the literal, so newlines collapse to spaces.
function quote(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\r\n]+/g, " ")}"`;
}
