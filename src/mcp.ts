// MCP server over the local mox mail store. Read-only queries, plus
// create_draft (appends to the account's IMAP Drafts folder — mox never
// sends; drafts are reviewed and sent from the provider's own UI).
//
// Register with Claude Code (once):
//   claude mcp add mox -- bun /ABSOLUTE/PATH/mox/src/mcp.ts
// or add to a project .mcp.json. Config/db are located exactly like the TUI
// ($MOX_CONFIG / repo ./config.yaml / ~/Documents/mox). See ./paths.ts.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { Store } from "./db.ts";
import { loadConfig } from "./config.ts";
import { backend } from "./backend.ts";
import { resolveCfgPath, resolveDbPath } from "./paths.ts";

const cfgPath = resolveCfgPath();
const dbPath = resolveDbPath(cfgPath);
const store = new Store(dbPath);
const cfg = loadConfig(cfgPath);
const actions = backend(store, cfg);

const server = new McpServer({ name: "mox", version: "1.0.0" });

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
  "create_draft",
  {
    title: "Create a draft",
    description:
      "Compose an email and save it to the account's IMAP Drafts folder (nicely formatted, " +
      "plain + HTML). mox never sends — the user reviews and sends it from their own mail UI. " +
      "Pass reply_to (a message id from search/list) to draft a threaded reply (to/subject " +
      "derived from the original, overridable); omit it for a standalone draft, which needs " +
      "account, to and subject. body is plain text; blank lines separate paragraphs.",
    inputSchema: {
      body: z.string(),
      reply_to: z.number().int().optional(),
      account: z.string().optional(),
      to: z.string().optional(),
      subject: z.string().optional(),
    },
  },
  async ({ body, reply_to, account, to, subject }) => {
    const res = await actions.draft({ body, replyTo: reply_to, account, to, subject });
    return { content: [{ type: "text", text: res.out }], isError: !res.ok };
  },
);

await server.connect(new StdioServerTransport());
