// Desktop notification. Auto-copied login codes land while you are looking at a
// browser, not at mox, so the status line alone would never be read — the
// banner is the only signal that reaches you there.
//
// Fire-and-forget by design: a missing notifier is not worth a status-line
// error when the clipboard write (the part that matters) already succeeded.
import { spawn } from "node:child_process";

/** notify shows a desktop banner. Silent no-op when no notifier is available. */
export function notify(title: string, body: string): void {
  if (process.platform === "darwin") {
    // Arguments go through AppleScript source, so both strings are escaped and
    // passed as a single -e program — never interpolated into a shell command.
    const script = `display notification ${quote(body)} with title ${quote(title)}`;
    run("osascript", ["-e", script]);
    return;
  }
  run("notify-send", [title, body]);
}

// An unhandled "error" event on a child process throws, and a machine without
// the notifier is a normal state here — swallow it.
function run(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

// AppleScript string literal: backslashes first, then quotes; newlines would
// end the literal, so they collapse to spaces.
function quote(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\r\n]+/g, " ")}"`;
}
