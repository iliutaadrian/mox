// One-time login code detection. A message qualifies when a configured gate
// word sits near a standalone 4-8 digit number; the candidate nearest a gate
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
//   - years are never candidates: "learn to code in 2024" and every calendar
//     invite otherwise reads as a hit.
//
// Two word lists, because the two places a code can sit have opposite risks.
// `words` are phrases ("verification code", "cod de siguranta") and apply
// everywhere: measured over the local corpus, bare words in a body turn
// ordinary Romanian business mail into hits (a fiscal code next to "cod", a
// year next to "verificare") — 112 hits per 933 bodied messages, against 26 for
// phrases. `subjectWords` are bare words and apply to the subject only, where
// the same measurement costs almost nothing (24 hits per 31k subjects) and is
// the only thing that catches "479982 is your Facebook code", which no phrase
// list can enumerate.
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
    // punctuation or spaces ("one-time", "sign in").
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu");
    for (const m of haystack.matchAll(pattern)) found.push({ span: { start: m.index, end: m.index + m[0].length }, word: needle });
  }
  return found;
}

// Gap between two spans; 0 when they touch or overlap.
function gap(a: Span, b: Span): number {
  return a.end <= b.start ? b.start - a.end : b.end <= a.start ? a.start - b.end : 0;
}

// A bare year is the single most common code-shaped number in ordinary mail
// (dates, invites, newsletters), and no service issues one as a code.
function isYear(s: string): boolean {
  return s.length === 4 && Number(s) >= 1900 && Number(s) <= 2099;
}

function scan(text: string, words: string[]): { code: string; word: string } | null {
  const clean = blank(blank(text, TAG), URL);
  const gates = wordSpans(clean.toLowerCase(), words);
  if (!gates.length) return null;

  let best: { code: string; word: string; distance: number } | null = null;
  for (const m of clean.matchAll(CODE)) {
    if (isYear(m[0])) continue;
    const span = { start: m.index, end: m.index + m[0].length };
    for (const gate of gates) {
      const distance = gap(span, gate.span);
      if (distance > MAX_GAP) continue;
      // Strictly nearer wins, so an equal-distance later candidate never
      // displaces the earlier one.
      if (!best || distance < best.distance) best = { code: m[0], word: gate.word, distance };
    }
  }
  return best ? { code: best.code, word: best.word } : null;
}

/** findLoginCode returns the one-time code a message carries, or null when no
 * gate word fires or no number sits close enough to one. The lists come from
 * config (`login_codes.words` / `login_codes.subject_words`); both empty
 * disables detection. The subject is scanned first — it is the
 * highest-confidence place a code can sit, and it survives body pruning. */
export function findLoginCode(subject: string, body: string, words: string[], subjectWords: string[] = []): LoginCode | null {
  if (!words.length && !subjectWords.length) return null;
  const fromSubject = scan(subject, [...words, ...subjectWords]);
  if (fromSubject) return { ...fromSubject, source: "subject" };
  const fromBody = words.length ? scan(body, words) : null;
  return fromBody ? { ...fromBody, source: "body" } : null;
}
