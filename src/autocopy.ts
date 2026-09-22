// The auto-copy step: given the mail a sync just inserted, put at most one
// one-time code on the clipboard and announce it. Split out of the TUI so the
// interface and `mox --code-demo` run the SAME path — a demo that reimplements
// the thing it demonstrates proves nothing.
//
// Deliberately not part of backend(): `mox --headless` calls backend.sync()
// with nobody at the keyboard, and a daemon must never touch the clipboard.
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { copyToClipboard } from "./clipboard.ts";
import { findLoginCode } from "./codes.ts";
import { notify } from "./notify.ts";

export type CodeCopy = {
  code: string;
  sender: string;
  word: string; // the gate word that claimed it
  source: "subject" | "body";
  copied: boolean;
  error: string; // clipboard failure reason, "" when it worked
  notified: string[]; // delivery paths tried, [] when notifications are off
  status: string; // the line to show on the status bar
};

/** codesEnabled reports whether config asks for login-code detection at all:
 * the master switch, plus at least one word to match with. */
export function codesEnabled(cfg: Config): boolean {
  return cfg.loginCodes && (cfg.loginCodesWords.length > 0 || cfg.loginCodesSubjectWords.length > 0);
}

/** copyArrivedCode scans the mail inserted after `sinceId` and copies the code
 * from the newest message carrying one. Returns null when the feature is off or
 * nothing qualified.
 *
 * Scanning only rows this sync actually inserted is what makes it exactly-once:
 * a re-fetch of mail already held inserts nothing (ON CONFLICT DO NOTHING), so
 * a code can never land on the clipboard a second time, on top of whatever was
 * copied since. */
export function copyArrivedCode(store: Store, cfg: Config, sinceId: number): CodeCopy | null {
  if (!codesEnabled(cfg) || !cfg.loginCodesAutoCopy) return null;
  for (const m of store.arrivedAfter(sinceId)) {
    const hit = findLoginCode(m.subject, m.body || m.html, cfg.loginCodesWords, cfg.loginCodesSubjectWords);
    if (!hit) continue;
    const sender = m.from_addr || "unknown sender";
    const r = copyToClipboard(hit.code);
    if (!r.ok) {
      return { ...hit, sender, copied: false, error: r.error, notified: [], status: `login code ${hit.code} — clipboard error: ${r.error.slice(0, 80)}` };
    }
    // The banner is the point: this fires while you are in a browser, where the
    // status line is out of sight.
    const notified = cfg.loginCodesNotify ? notify("mox", `${hit.code} copied · ${sender}`) : [];
    return { ...hit, sender, copied: true, error: "", notified, status: `copied code ${hit.code} from ${sender}` };
  }
  return null;
}
