// Config: reads config.yaml (accounts + categories). A category with a `match`
// block (domains / addresses / subject-or-sender words) files mail
// deterministically; one without holds only manually-moved mail.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";

export type Account = {
  name: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  mailbox: string;
};

export type Match = { domains: string[]; addresses: string[]; words: string[] };

export type Category = {
  name: string;
  description?: string;
  match?: Match;
};

export type Config = {
  accounts: Account[];
  categories: Category[];
  fetchLimit: number;
  fetchSinceDays: number;
  contentDays: number; // keep body/html only for mail newer than this; older = metadata-only, fetched on demand
  inboxExclude: string[]; // category names kept OUT of the INBOX view (still in ALL)
  offlineCategories: string[]; // categories whose mail is fully cached offline (bodies never pruned, backfilled)
  backupEnabled: boolean; // write periodic snapshots of the db into ./backup next to it
  backupEveryHours: number; // minimum age of the newest backup before another is taken
  backupKeep: number; // how many backups to keep; older ones are pruned
  backupDir: string; // where snapshots are written; "" = a backup/ folder next to the database
  headless: boolean; // launch the sync daemon instead of the TUI (servers with no terminal)
  headlessEverySeconds: number; // seconds between syncs in headless mode
  refreshEverySeconds: number; // seconds between the TUI's background inbox syncs
  dataDir: string; // where the database + Attachments/ live; "" = the built-in default
  loginCodes: boolean; // master switch for one-time login codes (auto-copy + the `yc` key)
  loginCodesAutoCopy: boolean; // copy a code to the clipboard as soon as the mail arrives (TUI only)
  loginCodesNotify: boolean; // announce an auto-copied code with a desktop notification
  loginCodesWords: string[]; // gate phrases, matched in subject and body
  loginCodesSubjectWords: string[]; // bare gate words, matched in the subject only
};

// A positive number from config, falling back to `def` for missing/garbage/<=0
// values — a typo must not silently disable backups or fill the disk.
function positive(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Gate words, lowercased and trimmed: they are matched case-insensitively, and
// a stray blank entry would otherwise match everywhere.
function words(v: unknown): string[] {
  return (Array.isArray(v) ? v : []).map((w) => String(w).trim().toLowerCase()).filter(Boolean);
}

/** expandPath turns a user-written path into an absolute one: `~` is the home
 * directory, and a relative path resolves against the process cwd. "" stays ""
 * so callers can tell "not set" from "set to somewhere". */
function expandPath(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  const home = homedir();
  const expanded = s === "~" ? home : s.startsWith("~/") ? join(home, s.slice(2)) : s;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function loadConfig(path: string): Config {
  const raw = parse(readFileSync(path, "utf8")) ?? {};
  const accounts: Account[] = (raw.accounts ?? []).map((a: any) => ({
    name: String(a.name),
    imapHost: String(a.imap_host ?? ""),
    imapPort: Number(a.imap_port ?? 993),
    imapUser: String(a.imap_user ?? "").trim(),
    imapPass: String(a.imap_pass ?? ""),
    mailbox: String(a.mailbox ?? "INBOX"),
  }));
  const categories: Category[] = (raw.categories ?? []).map((c: any) => ({
    name: String(c.name),
    description: c.description ? String(c.description) : undefined,
    match: c.match
      ? {
          domains: (c.match.domains ?? []).map(String),
          addresses: (c.match.addresses ?? []).map(String),
          words: (c.match.words ?? []).map(String),
        }
      : undefined,
  }));
  return {
    accounts,
    categories,
    fetchLimit: Number(raw.fetch_limit ?? 200),
    fetchSinceDays: Number(raw.fetch_since_days ?? 0),
    contentDays: Number(raw.content_days ?? 90),
    inboxExclude: (raw.inbox_exclude ?? []).map(String),
    offlineCategories: (raw.offline_categories ?? []).map(String),
    backupEnabled: raw.backup_enabled !== false, // on unless explicitly disabled
    backupEveryHours: positive(raw.backup_every_hours, 12),
    backupKeep: Math.max(1, Math.floor(positive(raw.backup_keep, 2))),
    backupDir: expandPath(raw.backup_dir),
    headless: raw.headless === true, // off unless explicitly enabled
    headlessEverySeconds: Math.floor(positive(raw.headless_every_seconds, 60)),
    refreshEverySeconds: Math.floor(positive(raw.refresh_every_seconds, 10)),
    dataDir: expandPath(raw.data_dir),
    // Off unless asked for: this writes to the system clipboard on its own, so a
    // config that never mentions it must never have it fire. The sub-switches
    // are on unless explicitly disabled, and mean nothing while the master is
    // off — same shape as headless / headless_every_seconds.
    loginCodes: raw.login_codes === true,
    loginCodesAutoCopy: raw.login_codes_auto_copy !== false,
    loginCodesNotify: raw.login_codes_notify !== false,
    loginCodesWords: words(raw.login_codes_words),
    loginCodesSubjectWords: words(raw.login_codes_subject_words),
  };
}

/** domainOf returns the lowercased domain part of an email address, or "". */
export function domainOf(addr: string): string {
  const a = addr.toLowerCase().trim();
  const i = a.lastIndexOf("@");
  return i >= 0 ? a.slice(i + 1) : "";
}

/**
 * matchCategory returns the name of the first category (in config order) whose
 * match rule claims this message, or "". A category matches on any of: an exact
 * sender address, a sender domain (incl. subdomains — github.com matches
 * ci.github.com), or a subject keyword (case-insensitive substring). Config
 * order IS the precedence: put muted/blocking categories first, then
 * keyword categories, then broad domain categories.
 */
export function matchCategory(cfg: Config, fromAddr: string, subject = "", fromName = ""): string {
  const addr = fromAddr.toLowerCase().trim();
  const domain = domainOf(addr);
  // Words match the subject OR the sender display name — some senders (e.g. via
  // Apple's private relay) share a domain and are only identifiable by name.
  const hay = `${subject} ${fromName}`.toLowerCase();
  for (const c of cfg.categories) {
    const m = c.match;
    if (!m) continue;
    if (addr && m.addresses?.some((a) => addr === a.toLowerCase())) return c.name;
    if (domain && m.domains?.some((d) => { const dl = d.toLowerCase(); return domain === dl || domain.endsWith("." + dl); })) return c.name;
    if (hay.trim() && m.words?.some((w) => hay.includes(w.toLowerCase()))) return c.name;
  }
  return "";
}

