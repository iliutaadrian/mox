// Config: reads config.yaml (accounts + categories). A category with a `match`
// block (domains / addresses / subject-or-sender words) files mail
// deterministically; one without holds only manually-moved mail.
import { readFileSync } from "node:fs";
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
};

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

