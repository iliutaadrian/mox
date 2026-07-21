// Width-safe text helpers. Widths are measured with string-width (the same
// library Ink uses to lay out), so a fitted column can never disagree with the
// renderer and wrap.
//
// Optional-emoji symbols (Emoji=Yes, Emoji_Presentation=No — e.g. "✍" in real
// eMAG subjects) render 1 or 2 cells depending on the terminal. Forcing
// explicit emoji presentation (VS16) makes the width unambiguous everywhere.
import stringWidth from "string-width";

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

// Measure with the SAME library Ink uses to lay out (string-width). A hand-
// rolled wcwidth disagrees on some emoji/CJK; a single-cell disagreement makes
// a row wrap inside its pane, which under rapid re-renders (holding a key) tears
// the screen. Using Ink's own measure guarantees rows never wrap.
export function width(s: string): number {
  return stringWidth(s);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Truncate to exactly w cells (… when cut) and right-pad with spaces. */
export function fit(s: string, w: number): string {
  if (w <= 0) return "";
  const total = stringWidth(s);
  if (total <= w) return s + " ".repeat(w - total);
  // Truncate grapheme-by-grapheme, leaving room for the ellipsis.
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(s)) {
    const gw = stringWidth(segment);
    if (used + gw > w - 1) break;
    out += segment;
    used += gw;
  }
  out += "…";
  used += 1;
  return out + " ".repeat(Math.max(0, w - used));
}
