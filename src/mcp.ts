// MCP server over the local spark-cli mail store (read-only). Lets Claude query
// your mail as first-class tools instead of shelling out to sqlite.
//
// Register with Claude Code (once):
//   claude mcp add spark -- bun /ABSOLUTE/PATH/spark-cli/src/mcp.ts
// or add to a project .mcp.json. Config/db are located exactly like the TUI
// ($SPARK_CONFIG / repo ./config.yaml / ~/.config/spark-cli/config.yaml).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { Store } from "./db.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath =
  [process.env.SPARK_CONFIG, join(repoRoot, "config.yaml"), join(homedir(), ".config", "spark-cli", "config.yaml")].find(
    (p) => p && existsSync(p),
  ) ?? join(repoRoot, "config.yaml");
const dbPath = process.env.SPARK_DB ?? join(dirname(cfgPath), "spark-cli.db");
const store = new Store(dbPath);

const server = new McpServer({ name: "spark-cli", version: "1.0.0" });

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
  "list_emails",
  {
    title: "List emails",
    description: "List messages in a category, folder (Sent/Spam/Archive/Trash), or account. Newest first.",
    inputSchema: {
      category: z.string().optional(),
      folder: z.enum(["Sent", "Spam", "Archive", "Trash"]).optional(),
      account: z.string().optional(),
      limit: z.number().int().max(500).default(50),
    },
  },
  async ({ category, folder, account, limit }) => {
    const f = category
      ? { kind: "category" as const, name: category }
      : folder
        ? { kind: "folder" as const, class: folder }
        : account
          ? { kind: "account" as const, name: account, exclude: [] }
          : { kind: "all" as const, exclude: [] };
    return { content: [{ type: "text", text: JSON.stringify(store.list(f, limit), null, 2) }] };
  },
);

server.registerTool(
  "email_stats",
  {
    title: "Email stats",
    description:
      "Grouped counts (with unread + first/last date). dim = year | month | sender | category. " +
      "Optional filters: category, account, mailbox (INBOX/Sent/Spam/Archive/Trash).",
    inputSchema: {
      dim: z.enum(["year", "month", "sender", "category"]),
      category: z.string().optional(),
      account: z.string().optional(),
      mailbox: z.string().optional(),
      limit: z.number().int().max(500).default(100),
    },
  },
  async ({ dim, category, account, mailbox, limit }) => {
    const rows = store.stats(dim, { category, account, mailbox }, limit);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
);

await server.connect(new StdioServerTransport());
