// Terminal mouse support. Ink does not parse mouse events, so we enable SGR
// mouse tracking (1000 = click, 1006 = SGR extended coords) and parse the
// escape sequences off stdin ourselves. Coordinates are 1-based from the
// terminal; callers get 0-based row/col to match Ink's layout.
import { useEffect, useRef } from "react";
import { useStdin } from "ink";

export type MouseEvent = {
  type: "down" | "up" | "wheelup" | "wheeldown";
  // 0-based screen coordinates
  row: number;
  col: number;
};

// SGR mouse report: ESC [ < b ; x ; y (M=press, m=release)
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

export function useMouse(handler: (e: MouseEvent) => void) {
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  // Keep the latest handler in a ref so the stdin listener never re-subscribes
  // — re-subscribing would toggle mouse tracking on/off every render.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!isRawModeSupported || !stdin) return;
    setRawMode(true);
    // Enable: 1000 button events, 1006 SGR coords.
    process.stdout.write("\x1b[?1000h\x1b[?1006h");

    const onData = (data: Buffer | string) => {
      const s = typeof data === "string" ? data : data.toString("utf8");
      SGR.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SGR.exec(s)) !== null) {
        const b = Number(m[1]);
        const col = Number(m[2]) - 1;
        const row = Number(m[3]) - 1;
        const release = m[4] === "m";
        const h = handlerRef.current;
        if (b === 64) h({ type: "wheelup", row, col });
        else if (b === 65) h({ type: "wheeldown", row, col });
        else if ((b & 0b11) === 0) h({ type: release ? "up" : "down", row, col });
      }
    };

    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      process.stdout.write("\x1b[?1000l\x1b[?1006l");
    };
  }, [stdin, setRawMode, isRawModeSupported]);
}

// Mouse escape sequences also reach Ink's useInput as junk "keypresses".
// Callers use this to ignore them.
export function isMouseSeq(input: string): boolean {
  return input.includes("\x1b[<") || input.startsWith("[<");
}
