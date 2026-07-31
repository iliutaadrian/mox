// MCP server over the local mox mail store: read the mail, triage it, re-file
// it, download attachments and draft replies. Every write goes through
// backend(), the same in-process actions the TUI uses, so there is one
// implementation of "trash" or "done" and not two. Drafts are appended to the
// account's IMAP Drafts folder - mox never sends; drafts are reviewed and sent
// from the provider's own UI.
//
// Register with Claude Code (once). Installed binary:
//   claude mcp add -s user mox -- mox mcp
// Dev checkout:
//   claude mcp add -s user mox -- bun /ABSOLUTE/PATH/mox/src/mcp.ts
// `-s user` registers it for every session; the default scope covers only the
// current project. Bare `mox` must be on the PATH of whatever spawns MCP servers
// (install.sh targets ~/.local/bin) — register the absolute binary path if it is
// not. Config/db are located exactly like the TUI ($MOX_CONFIG /
// repo ./config.yaml / ~/Documents/mox). See ./paths.ts.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { Store } from "./db.ts";
import { loadConfig } from "./config.ts";
import { backend } from "./backend.ts";
import { resolveCfgPath, resolveDbPath } from "./paths.ts";
import pkg from "../package.json";

const cfgPath = resolveCfgPath();
const dbPath = resolveDbPath(cfgPath);
const store = new Store(dbPath);
const cfg = loadConfig(cfgPath);
const actions = backend(store, cfg);

const server = new McpServer({ name: "mox", version: pkg.version });

// Categories the user actually curates: config.yaml plus the ones approved in
// the TUI. Re-read per call - a category approved while the server is running
// must not be rejected as unknown.
function knownCategories(): string[] {
  return [...new Set([...cfg.categories.map((c) => c.name), ...store.approvedCategories()])];
}

server.registerTool(
  "search_emails",
  {
    title: "Search emails",
    description:
      "Full-text search over the local mail store. Supports operators: from:, subject:/subj:, " +
      "body:, is:unread|read, has:attachment, in:inbox|sent|spam|archive; bare words match " +
      "subject/sender/body; quoted \"phrases\" allowed. Excludes Spam/Trash/Archive unless in: is used.",
    inputSchema: { query: z.string(), limit: z.number().int().max(500).default(50) },
  },
  async ({ query, limit }) => {
    const rows = store.list({ kind: "search", query }, limit);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
);

server.registerTool(
  "get_email",
  {
    title: "Get one email",
    description: "Full headers + plain-text body + HTML for one message id.",
    inputSchema: { id: z.number().int() },
  },
  async ({ id }) => {
    const m = store.full(id);
    if (!m) return { content: [{ type: "text", text: "not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(m, null, 2) }] };
  },
);

server.registerTool(
  "get_inbox",
  {
    title: "Get the inbox (undone mail)",
    description:
      "The active inbox: mail still waiting to be dealt with, newest first. Excludes anything " +
      "marked done, trashed or archived, and leaves out the muted categories from config.yaml " +
      "(inbox_exclude). Start here for \"what's in my inbox\", \"what still needs an answer\", " +
      "\"anything new today\". Metadata only (id, sender, subject, date, seen, category) - call " +
      "get_email for a body, and pass the ids on to triage_emails / set_category.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(50),
      unread_only: z.boolean().default(false),
    },
  },
  async ({ limit, unread_only }) => {
    // Seen state is not part of the inbox filter, so over-fetch and trim to keep
    // unread_only from returning fewer rows than the caller asked for.
    const rows = store.list({ kind: "inbox", exclude: cfg.inboxExclude }, unread_only ? Math.min(limit * 10, 2000) : limit);
    const out = (unread_only ? rows.filter((r) => r.seen === 0) : rows).slice(0, limit);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },
);

server.registerTool(
  "triage_emails",
  {
    title: "Triage emails",
    description:
      "Act on one or many emails at once - pass every id you want to touch in a single call " +
      "(ids come from get_inbox or search_emails). Local only, invisible to the mail server: " +
      "'done' clears mail out of the inbox view (the everyday \"I'm finished with this\"), " +
      "'undone' brings it back. Real moves on the IMAP server, visible in every other mail " +
      "client: 'trash'/'untrash' and 'archive'/'unarchive' (both restore to the inbox). " +
      "'read'/'unread' also writes the flag to the server. Prefer 'done' when the user just " +
      "wants their inbox cleared; use trash/archive only when they say so.",
    inputSchema: {
      ids: z.array(z.number().int()).min(1),
      action: z.enum(["done", "undone", "trash", "archive", "untrash", "unarchive", "read", "unread"]),
    },
  },
  async ({ ids, action }) => {
    const res = await (action === "done" ? actions.done(ids, true)
      : action === "undone" ? actions.done(ids, false)
      : action === "read" ? actions.mark(ids, true)
      : action === "unread" ? actions.mark(ids, false)
      : action === "trash" ? actions.trash(ids)
      : action === "archive" ? actions.archive(ids)
      : action === "untrash" ? actions.untrash(ids)
      : actions.unarchive(ids));
    return { content: [{ type: "text", text: res.out }], isError: !res.ok };
  },
);

server.registerTool(
  "set_category",
  {
    title: "Set the category of emails",
    description:
      "Re-file mail into one of the user's categories. The category is a local label only - it " +
      "is never written to the mail server, and nothing moves folders. Two modes: pass ids for " +
      "specific messages, or pass from to sweep every inbox message from that sender (\"put " +
      "everything from oxigen@contact.ro in Travel\"). from is matched as an exact address, not " +
      "a domain, so use the full address. The change is recorded as the user's own choice, so a " +
      `later \`mox --reclassify\` will not undo it. Existing categories: ${knownCategories().join(", ") || "(none configured)"}. ` +
      "A category outside that list is rejected - report the valid ones back to the user rather " +
      "than inventing a new one.",
    inputSchema: {
      category: z.string(),
      ids: z.array(z.number().int()).optional(),
      from: z.string().optional(),
    },
  },
  async ({ category, ids, from }) => {
    const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
    if (from && ids?.length) return err("pass either ids or from, not both");
    if (!from && !ids?.length) return err("set_category needs ids or from");
    const known = knownCategories();
    const match = known.find((c) => c.toLowerCase() === category.trim().toLowerCase());
    if (!match) return err(`unknown category "${category}" - pick one of: ${known.join(", ") || "(none configured)"}`);
    const res = from ? actions.moveBySender(from.trim(), match) : actions.move(ids!, match);
    return { content: [{ type: "text", text: res.out }], isError: !res.ok };
  },
);

server.registerTool(
  "download_attachments",
  {
    title: "Download an email's attachments",
    description:
      "Fetch every attachment of one email from the server and save it to an Attachments/ folder " +
      "next to the mox database (the mox checkout, or ~/Documents/mox for an installed mox), NOT " +
      "the directory this server was started in and NOT the project you happen to be chatting " +
      "about. A single file lands in Attachments/; several go into a subfolder named after the subject. " +
      "Reports what it saved, or \"no attachments\" if the message carries none.",
    inputSchema: { id: z.number().int() },
  },
  async ({ id }) => {
    const res = await actions.download(id);
    return { content: [{ type: "text", text: res.out }], isError: !res.ok };
  },
);

server.registerTool(
  "create_draft",
  {
    title: "Reply to an email (as a draft)",
    description:
      "THE tool for \"respond to this email\", \"reply to X\", \"answer this one\" - write the " +
      "answer and save it as a draft. Pass reply_to (a message id from get_inbox / search_emails) " +
      "and body; to, subject and threading are derived from the original and can be overridden. " +
      "Omit reply_to for a standalone new email, which needs account, to and subject. mox never " +
      "sends: the draft is appended to the account's IMAP Drafts folder (plain + HTML) and the " +
      "user reviews and sends it from their own mail app. body is plain text; blank lines " +
      "separate paragraphs. attachments takes PATHS to files already on disk - mox reads the bytes " +
      "itself, so never paste file contents or base64 into this call. Each path must be absolute " +
      "or start with ~/; a relative path is refused, because it would resolve against whatever " +
      "directory this server was started in and not the project you are chatting about. A path " +
      "that cannot be read fails the whole draft rather than appending mail without its file.",
    inputSchema: {
      body: z.string(),
      reply_to: z.number().int().optional(),
      account: z.string().optional(),
      to: z.string().optional(),
      subject: z.string().optional(),
      attachments: z.array(z.string()).optional(),
    },
  },
  async ({ body, reply_to, account, to, subject, attachments }) => {
    const res = await actions.draft({ body, replyTo: reply_to, account, to, subject, attachments });
    return { content: [{ type: "text", text: res.out }], isError: !res.ok };
  },
);

await server.connect(new StdioServerTransport());
