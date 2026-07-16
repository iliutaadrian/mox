// Width-safe text helpers, ported from the Go TUI (internal/tui/tui.go).
//
// Optional-emoji symbols (Emoji=Yes, Emoji_Presentation=No — e.g. "✍" in real
// eMAG subjects) are rendered 1 or 2 cells wide depending on the terminal.
// Forcing explicit emoji presentation (VS16) makes every width authority agree
// on 2 cells, so a row can never silently overflow its column and corrupt the
// frame. Same table as the Go implementation.
const OPTIONAL_EMOJI: [number, number][] = [
  [0x203c, 0x203c], [0x2049, 0x2049],
  [0x2194, 0x2199], [0x21a9, 0x21aa],
  [0x2328, 0x2328], [0x23cf, 0x23cf],
  [0x23ed, 0x23ef], [0x23f1, 0x23f2], [0x23f8, 0x23fa],
  [0x25aa, 0x25ab], [0x25b6, 0x25b6], [0x25c0, 0x25c0], [0x25fb, 0x25fc],
  [0x2600, 0x2604], [0x260e, 0x260e], [0x2611, 0x2611],
  [0x2618, 0x2618], [0x261d, 0x261d], [0x2620, 0x2620],
  [0x2622, 0x2623], [0x2626, 0x2626], [0x262a, 0x262a],
  [0x262e, 0x262f], [0x2638, 0x263a], [0x2640, 0x2640],
  [0x2642, 0x2642], [0x265f, 0x2660], [0x2663, 0x2663],
  [0x2665, 0x2666], [0x2668, 0x2668], [0x267b, 0x267b],
  [0x267e, 0x267e], [0x2692, 0x2692], [0x2694, 0x2697],
  [0x2699, 0x2699], [0x269b, 0x269c], [0x26a0, 0x26a0],
  [0x26a7, 0x26a7], [0x26b0, 0x26b1], [0x26c8, 0x26c8],
  [0x26cf, 0x26cf], [0x26d1, 0x26d1], [0x26d3, 0x26d3],
  [0x26e9, 0x26e9], [0x26f0, 0x26f1], [0x26f4, 0x26f4], [0x26f7, 0x26f9],
  [0x2702, 0x2702], [0x2708, 0x2709], [0x270c, 0x270d],
  [0x270f, 0x270f], [0x2712, 0x2712], [0x2714, 0x2714],
  [0x2716, 0x2716], [0x271d, 0x271d], [0x2721, 0x2721],
  [0x2733, 0x2734], [0x2744, 0x2744], [0x2747, 0x2747],
  [0x2763, 0x2764], [0x27a1, 0x27a1],
  [0x2934, 0x2935], [0x2b05, 0x2b07],
  [0x3030, 0x3030], [0x303d, 0x303d], [0x3297, 0x3297], [0x3299, 0x3299],
];

function isOptionalEmoji(cp: number): boolean {
  for (const [lo, hi] of OPTIONAL_EMOJI) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

export function emojiPresentation(s: string): string {
  let out = "";
  const cps = [...s];
  for (let i = 0; i < cps.length; i++) {
    out += cps[i];
    if (isOptionalEmoji(cps[i]!.codePointAt(0)!)) {
      const next = i + 1 < cps.length ? cps[i + 1]!.codePointAt(0) : 0;
      if (next !== 0xfe0e && next !== 0xfe0f) out += "️";
    }
  }
  return out;
}

/** Flatten newlines/tabs and normalize emoji presentation (list rows). */
export function oneLine(s: string): string {
  return emojiPresentation(s.replace(/[\r\n\t]+/g, " "));
}

// Display width per code point: emoji presentation, East Asian Wide, and the
// common wide ranges count 2. Simplified wcwidth — matches what terminals do
// for mail-subject content.
function cpWidth(cp: number): number {
  if (cp === 0xfe0f || cp === 0xfe0e || cp === 0x200d) return 0; // selectors, ZWJ
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) || // pictographs
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23f3) ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f || cp === 0x2693 || cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce || cp === 0x26d4 || cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd ||
    cp === 0x2705 || (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 || cp === 0x274c || cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) || cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) || cp === 0x27b0 || cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) || cp === 0x2b50 || cp === 0x2b55
  ) {
    return 2;
  }
  return 1;
}

// A grapheme with VS16 gets width 2 even if its base is narrow; our
// normalization guarantees optional emoji always carry VS16.
export function width(s: string): number {
  const cps = [...s];
  let w = 0;
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!.codePointAt(0)!;
    if (cp === 0xfe0f && i > 0 && cpWidth(cps[i - 1]!.codePointAt(0)!) === 1) {
      w += 1; // VS16 promotes narrow base to 2
      continue;
    }
    w += cpWidth(cp);
  }
  return w;
}

/** Truncate to exactly w cells (… when cut) and right-pad with spaces. */
export function fit(s: string, w: number): string {
  if (w <= 0) return "";
  if (width(s) <= w) return s + " ".repeat(w - width(s));
  let out = "";
  let used = 0;
  const cps = [...s];
  for (let i = 0; i < cps.length; i++) {
    let cw = cpWidth(cps[i]!.codePointAt(0)!);
    // keep VS16 with its base
    if (i + 1 < cps.length && cps[i + 1]!.codePointAt(0) === 0xfe0f) {
      cw = Math.max(cw + 0, 2);
    }
    if (used + cw > w - 1) break;
    out += cps[i];
    if (i + 1 < cps.length && cps[i + 1]!.codePointAt(0) === 0xfe0f) {
      out += cps[i + 1];
      i++;
    }
    used += cw;
  }
  out += "…";
  used += 1;
  return out + " ".repeat(Math.max(0, w - used));
}
