// Config: reads config.yaml (accounts + categories). Mirrors the former Go
// internal/config. A category with a `match` block of sender rules is "manual"
// (filed deterministically); one without holds only manually-moved mail.
import { readFileSync, writeFileSync } from "node:fs";
import { parse, parseDocument, YAMLSeq, YAMLMap } from "yaml";

export type Account = {
  name: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  mailbox: string;
};

export type Match = { domains: string[]; addresses: string[] };

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
};

export function categoryHasRules(c: Category): boolean {
  return !!c.match && ((c.match.domains?.length ?? 0) > 0 || (c.match.addresses?.length ?? 0) > 0);
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
        }
      : undefined,
  }));
  return {
    accounts,
    categories,
    fetchLimit: Number(raw.fetch_limit ?? 200),
    fetchSinceDays: Number(raw.fetch_since_days ?? 0),
  };
}

/** domainOf returns the lowercased domain part of an email address, or "". */
export function domainOf(addr: string): string {
  const a = addr.toLowerCase().trim();
  const i = a.lastIndexOf("@");
  return i >= 0 ? a.slice(i + 1) : "";
}

/**
 * matchCategory returns the category name whose sender rule matches fromAddr,
 * or "". Exact-address rules take precedence over domain rules; within each
 * kind, categories are checked in config order. A domain rule also matches
 * subdomains (github.com matches ci.github.com).
 */
export function matchCategory(cfg: Config, fromAddr: string): string {
  const addr = fromAddr.toLowerCase().trim();
  if (!addr) return "";
  const domain = domainOf(addr);
  // Exact address first.
  for (const c of cfg.categories) {
    for (const a of c.match?.addresses ?? []) {
      if (addr === a.toLowerCase()) return c.name;
    }
  }
  // Then domain (incl. subdomain).
  for (const c of cfg.categories) {
    for (const d of c.match?.domains ?? []) {
      const dl = d.toLowerCase();
      if (domain === dl || domain.endsWith("." + dl)) return c.name;
    }
  }
  return "";
}

/**
 * addSenderRule appends domains (and addresses) to the named category's match
 * block in config.yaml, preserving comments/formatting. Creates the category
 * if missing. Used by the in-app "create rule" (A) action.
 */
export function addSenderRule(path: string, category: string, domains: string[], addresses: string[]) {
  const doc = parseDocument(readFileSync(path, "utf8"));
  let cats = doc.get("categories") as YAMLSeq | undefined;
  if (!cats) {
    cats = new YAMLSeq();
    doc.set("categories", cats);
  }
  let node = cats.items.find((it: any) => (it as YAMLMap)?.get("name") === category) as YAMLMap | undefined;
  if (!node) {
    node = new YAMLMap();
    node.set("name", category);
    cats.add(node);
  }
  let match = node.get("match") as YAMLMap | undefined;
  if (!match) {
    match = new YAMLMap();
    node.set("match", match);
  }
  const merge = (key: string, add: string[]) => {
    if (add.length === 0) return;
    const cur = (match!.get(key) as YAMLSeq | undefined)?.toJSON?.() ?? [];
    const set = new Set<string>([...cur.map(String), ...add]);
    match!.set(key, [...set].sort()); // plain array -> yaml builds the seq node
  };
  merge("domains", domains);
  merge("addresses", addresses);
  writeFileSync(path, doc.toString());
}
