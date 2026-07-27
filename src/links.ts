// Numbered-link rendering: lynx flows an email's HTML to text with [N] link
// references inline, and the link targets are extracted separately so the UI
// can offer a filterable "open link" picker instead of lynx's raw URL dump.
// Plain-text bodies get the same treatment by numbering their bare URLs.
// Pure + side-effect free (lynx subprocess aside); shared by the TUI reader
// (app.tsx) and the numbered-link lab (reference-mock.tsx).
import { spawnSync } from "node:child_process";

import { oneLine } from "./text.ts";

export type LinkRef = {
  number: number;
  url: string;
  label: string; // anchor text (or a context/URL-derived fallback) — used for filtering
  context: string; // the rendered line the reference sits on — used for filtering
  host: string;
  tracking: boolean;
};

export type RenderedEmail = { body: string; links: LinkRef[]; hiddenCount: number };

// Guarded: a malformed numeric entity (&#99999999;) must not crash the render.
function codePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

function decodeHtml(value: string): string {
  // &amp; is decoded LAST so "&amp;lt;" ends as "&lt;", not "<" (double decode).
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n: string) => codePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n: string) => codePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/gi, "&");
}

function attr(attrs: string, name: string): string {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function textFromHtml(fragment: string): string {
  const withImageLabels = fragment.replace(/<img\b([^>]*)>/gi, (_, attrs: string) => ` ${attr(attrs, "alt") || attr(attrs, "title")} `);
  return oneLine(decodeHtml(withImageLabels.replace(/<[^>]+>/g, " "))).trim();
}

// Anchor text per href, in document order — lynx numbers links in the same
// order, so labels can be matched back to the extracted URL list.
function htmlAnchors(html: string): { url: string; label: string }[] {
  const anchors: { url: string; label: string }[] = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    const url = attr(match[1] ?? "", "href").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const label = textFromHtml(match[2] ?? "") || attr(match[1] ?? "", "title");
    anchors.push({ url, label });
  }
  return anchors;
}

function cleanUrl(url: string): string {
  return decodeHtml(url).replace(/[\])},.;:!?]+$/, "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown host";
  }
}

function looksTracked(url: string, host: string): boolean {
  return /(^|\.)(click|link|links|track|tracking|trk|email)\./i.test(host) || /[?&](utm_|mc_|mkt_|vero_|_hs)/i.test(url) || url.length > 180;
}

function lineContext(body: string, number: number): string {
  const marker = `[${number}]`;
  const line = body.split("\n").find((candidate) => candidate.includes(marker));
  return line ? oneLine(line.replaceAll(marker, " ")).trim() : "";
}

function fallbackLabel(context: string, number: number, url: string): string {
  const marker = `[${number}]`;
  const source = context.includes(marker) ? context.slice(context.indexOf(marker) + marker.length) : context;
  const cleaned = oneLine(source.replace(/\[\d+\]/g, " ")).trim();
  if (cleaned && cleaned.length <= 100) return cleaned;
  const host = hostOf(url);
  try {
    const path = decodeURIComponent(new URL(url).pathname).split("/").filter(Boolean).at(-1);
    return path && path.length <= 60 ? path.replace(/[-_]+/g, " ") : host;
  } catch {
    return host;
  }
}

function runLynx(html: string, width: number, linksOnly = false): string {
  const args = [
    "-dump",
    ...(linksOnly ? ["-listonly", "-width=1000"] : ["-nolist", "-number_links", `-width=${Math.max(40, width)}`]),
    "-force_html",
    "-nomargins",
    "-assume_charset=utf-8",
    "-display_charset=utf-8",
    "-stdin",
  ];
  const result = spawnSync("lynx", args, { input: html, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : "";
}

function plainEmail(body: string): RenderedEmail {
  const found = [...new Set((body.match(/\bhttps?:\/\/[^\s"'<>]+/gi) ?? []).map(cleanUrl))].slice(0, 50);
  // Number in appearance order, but REPLACE longest-first: a URL that is a
  // prefix of another (site root vs deep link) must not clobber the longer one.
  const numberOf = new Map(found.map((url, index) => [url, index + 1]));
  let numberedBody = body;
  for (const url of [...found].sort((a, b) => b.length - a.length)) {
    numberedBody = numberedBody.replaceAll(url, `[${numberOf.get(url)}]`);
  }
  // Contexts only after ALL urls are numbered, so no raw URL leaks into them.
  const links = found.map((url) => {
    const number = numberOf.get(url)!;
    const context = lineContext(numberedBody, number);
    const host = hostOf(url);
    return { number, url, label: fallbackLabel(context, number, url), context, host, tracking: looksTracked(url, host) };
  });
  return { body: numberedBody, links, hiddenCount: 0 };
}

/** renderEmail flows an email to display text with [N] link references and the
 * extracted link list. HTML goes through lynx (two runs: numbered body +
 * -listonly URL list, matched by number); plain text numbers its bare URLs.
 * hiddenCount = links lynx knows about that never surface in the visible body
 * (invisible/duplicate anchors). */
export function renderEmail(html: string, plainBody: string, width: number): RenderedEmail {
  if (!html.trim()) return plainEmail(plainBody);

  const body = runLynx(html, width);
  if (!body.trim()) return plainEmail(plainBody || html.replace(/<[^>]+>/g, " "));

  const anchors = htmlAnchors(html);
  const labelsByUrl = new Map<string, string[]>();
  for (const anchor of anchors) {
    const key = cleanUrl(anchor.url);
    if (!anchor.label) continue;
    labelsByUrl.set(key, [...(labelsByUrl.get(key) ?? []), anchor.label]);
  }

  const list = runLynx(html, width, true);
  const parsed = [...list.matchAll(/^\s*(\d+)\.\s+(https?:\/\/\S+)/gm)];
  const allLinks = parsed.map((match) => {
    const number = Number(match[1]);
    const url = cleanUrl(match[2] ?? "");
    const context = lineContext(body, number);
    const host = hostOf(url);
    const label = labelsByUrl.get(url)?.shift() || fallbackLabel(context, number, url);
    return { number, url, label, context, host, tracking: looksTracked(url, host) };
  });
  const links = allLinks.filter((link) => body.includes(`[${link.number}]`));
  return { body, links, hiddenCount: allLinks.length - links.length };
}

/** filterLinks narrows the picker list: a numeric query prefix-matches the
 * reference number; anything else substring-matches number/label/context/host/url. */
export function filterLinks(links: LinkRef[], query: string): LinkRef[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return links;
  if (/^\d+$/.test(needle)) return links.filter((link) => String(link.number).startsWith(needle));
  return links.filter((link) =>
    `${link.number} ${link.label} ${link.context} ${link.host} ${link.url}`.toLowerCase().includes(needle),
  );
}
