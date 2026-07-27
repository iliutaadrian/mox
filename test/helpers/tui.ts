// Drive the real TUI from a test and read the rendered screen back.
//
// OpenTUI ships an in-process test renderer (`testRender` from @opentui/solid)
// with a mock keyboard and mouse, so tests mount the actual <App/>, send real
// key and mouse events through the same handlers a terminal would drive, and
// capture the painted frame as text. No pty, no sleeps, no flakiness — and it
// works headless, which a real terminal app otherwise does not.
//
// The alternative (spawning the binary under `script` to get a pty) needs a
// controlling terminal that a test runner does not have, so it is not used here.
import { testRender } from "@opentui/solid";

import { App } from "../../src/app.tsx";
import type { Fixture } from "./fixture.ts";

export type Harness = Awaited<ReturnType<typeof testRender>> & {
  /** The visible screen as text. */
  frame: () => string;
  /** Every frame painted since start, newest last. */
  history: () => string[];
  /** Did ANY painted frame contain this text? Use for transient status lines:
   * a message like "Trashing on server…" is replaced as soon as the action
   * finishes, so asserting on the current frame alone silently misses it. */
  everSaw: (needle: string) => boolean;
  /** Type characters one at a time, letting the app repaint between them. */
  type: (keys: string) => Promise<void>;
  /** Press a named key (see KeyCodes) or a single character. */
  key: (k: string) => Promise<void>;
  /** Tear down the renderer (stops timers and IMAP warm-up). */
  stop: () => void;
};

export const KEY = {
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  backspace: "\x7f",
};

/** Mount the app against a fixture mailbox and settle the first paint. */
export async function startApp(fx: Fixture, size?: { width?: number; height?: number }): Promise<Harness> {
  const t = await testRender(() => App({ dbPath: fx.dbPath, cfgPath: fx.configPath }), {
    width: size?.width ?? 100,
    height: size?.height ?? 30,
  });
  await t.waitForVisualIdle();

  const seen: string[] = [t.captureCharFrame()];
  const settle = async () => {
    // The app repaints on its own after async work (body fetch, backend calls),
    // so give the renderer a chance to reach a steady state after every input.
    // Both the immediate paint AND the settled one are recorded: transient
    // status lines only exist in the first.
    await t.flush();
    seen.push(t.captureCharFrame());
    await t.waitForVisualIdle({ quietFrames: 2, maxFrames: 40 }).catch(() => {});
    seen.push(t.captureCharFrame());
  };

  const harness: Harness = Object.assign(t, {
    frame: () => t.captureCharFrame(),
    history: () => [...seen],
    everSaw: (needle: string) => seen.some((f) => f.includes(needle)),
    type: async (keys: string) => {
      for (const ch of keys) {
        t.mockInput.pressKey(ch);
        await settle();
      }
    },
    key: async (k: string) => {
      // Escape needs pressKeys() with a delay: a lone "\x1b" is the prefix of
      // every escape sequence, so the parser holds it until the delay flushes.
      // (pressEscape() never arrives, and pressKey("escape") types the LETTERS
      // e-s-c-a-p-e — which in this app means done, archive, prev-unread…)
      if (k === KEY.escape) await t.mockInput.pressKeys(["\x1b"], 60);
      else if (k === KEY.enter) t.mockInput.pressEnter();
      else t.mockInput.pressKey(k);
      await settle();
    },
    stop: () => t.renderer.destroy(),
  });
  return harness;
}

/** The reader/list pane interior, so assertions ignore the sidebar chrome.
 * The split point is found per row (the last border before the content) rather
 * than hard-coded, because the sidebar width moves with the layout. */
export function pane(frame: string): string[] {
  return frame
    .split("\n")
    .map((l) => {
      const border = l.lastIndexOf("│", 34);
      return (border >= 0 ? l.slice(border + 1) : l).replace(/[│╭╮╰╯]/g, "").trimEnd();
    })
    .filter((l) => l.trim().length);
}

/** The footer hint line (last non-empty row). */
export function hint(frame: string): string {
  const rows = frame.split("\n").filter((l) => l.trim().length);
  return rows[rows.length - 1] ?? "";
}
