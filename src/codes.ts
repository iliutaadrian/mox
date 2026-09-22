// One-time login code detection. A message qualifies when a gate word below
// sits near a standalone 4-8 digit number; the candidate nearest a gate
// word wins. The output goes straight to the system clipboard, so the rule is
// deliberately narrow — a wrong pick is a wrong number pasted into a login
// form, which is worse than no pick at all.
//
// Shape decisions, all taken against the real corpus (ANAF, E.ON, Golf Genius,
// LinkedIn, Facebook):
//   - subject is scanned before the body: subject-carried codes are the
//     highest-confidence case and survive body pruning (see Store.pruneContent).
//   - a candidate may sit either side of the gate word ("479982 is your
//     Facebook code" puts it first).
//   - URLs are dropped before scanning: tracking links are full of digit runs.
//   - digits only. Every sender in the corpus is numeric, and admitting
//     alphanumeric tokens would swallow ticket ids, shas and coupon codes.
//   - a year only counts when it is right up against the gate word, so
//     "learn to code in 2024" is not a hit but "your code is 2024" still is.
//
// Two word lists, because the two places a code can sit have opposite risks.
// `words` are phrases and apply everywhere: measured over a real 31k-message
// mailbox, bare words in a body turn ordinary Romanian business mail into hits
// (a fiscal code next to "cod", a year next to "verificare") — 112 hits per 933
// bodied messages, against 26 for phrases. `subject_words` are bare and apply to
// the subject only, where the same measurement costs almost nothing (24 hits
// per 31k subjects) and is the only thing that catches "479982 is your Facebook
// code", which no phrase list can enumerate. Together: 45 hits over 31,557
// messages, every one a genuine code mail.

export type LoginCode = {
  code: string;
  word: string; // the gate word that claimed it — shown when explaining a hit
  source: "subject" | "body";
};

// How far a number may sit from its gate word, in characters. The corpus gap is
// small (ANAF 2, E.ON ~30 across blank lines, Golf Genius ~4), so the cap is
// generous for real mail and still refuses a number a paragraph away.
const MAX_GAP = 120;

const CODE = /(?<![\p{L}\p{N}])\d{4,8}(?![\p{L}\p{N}])/gu;
const URL = /\bhttps?:\/\/\S+/gi;
const TAG = /<[^>]*>/g;

// Blanked out, never cut: every replacement keeps its original length so the
// offsets gate words and candidates are measured at stay in step.
function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, (m) => " ".repeat(m.length));
}

type Span = { start: number; end: number };

function wordSpans(haystack: string, words: string[]): { span: Span; word: string }[] {
  const found: { span: Span; word: string }[] = [];
  for (const word of words) {
    const needle = word.trim().toLowerCase();
    if (!needle) continue;
    // Gate words must stand alone: "cod" must not fire inside "codrul", and
    // "pin" must not fire inside "shipping". Escaped because a word may carry
    // punctuation or spaces ("one-time", "sign in"). Case-folded by the `i`
    // flag rather than by lowercasing the text: toLowerCase() can change a
    // string's length ("İ" becomes two characters), which would shift every
    // span away from the text the numbers are matched in.
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
    for (const m of haystack.matchAll(pattern)) found.push({ span: { start: m.index, end: m.index + m[0].length }, word: needle });
  }
  return found;
}

// Gap between two spans; 0 when they touch or overlap.
function gap(a: Span, b: Span): number {
  return a.end <= b.start ? b.start - a.end : b.end <= a.start ? a.start - b.end : 0;
}

// A bare year is the single most common code-shaped number in ordinary mail
// (dates, invites, newsletters). Rejecting every 1900-2099 candidate outright
// would also drop a genuine four-digit code that happens to read as a year, so
// a year has to earn its place instead: it counts only when it sits right up
// against the gate word ("code: 2024"), never at prose distance ("learn to code
// in 2024", the measured false positive).
const YEAR_MAX_GAP = 3;

function isYear(s: string): boolean {
  return s.length === 4 && Number(s) >= 1900 && Number(s) <= 2099;
}

function scan(text: string, words: string[]): { code: string; word: string } | null {
  const clean = blank(blank(text, TAG), URL);
  const gates = wordSpans(clean, words);
  if (!gates.length) return null;

  let best: { code: string; word: string; distance: number } | null = null;
  for (const m of clean.matchAll(CODE)) {
    const span = { start: m.index, end: m.index + m[0].length };
    const limit = isYear(m[0]) ? YEAR_MAX_GAP : MAX_GAP;
    for (const gate of gates) {
      const distance = gap(span, gate.span);
      if (distance > limit) continue;
      // Strictly nearer wins, so an equal-distance later candidate never
      // displaces the earlier one.
      if (!best || distance < best.distance) best = { code: m[0], word: gate.word, distance };
    }
  }
  return best ? { code: best.code, word: best.word } : null;
}

/** findLoginCode returns the one-time code a message carries, or null when no
 * gate word fires or no number sits close enough to one. Both lists come from
 * config (`login_codes.words` / `login_codes.subject_words`) so the languages
 * and services mox knows about are a file anyone can edit, not a constant in
 * this module; both empty disables detection. The subject is scanned first — it
 * is the highest-confidence place a code can sit, and it survives body pruning. */
export function findLoginCode(subject: string, body: string, words: string[], subjectWords: string[] = []): LoginCode | null {
  if (!words.length && !subjectWords.length) return null;
  const fromSubject = scan(subject, [...words, ...subjectWords]);
  if (fromSubject) return { ...fromSubject, source: "subject" };
  const fromBody = words.length ? scan(body, words) : null;
  return fromBody ? { ...fromBody, source: "body" } : null;
}
