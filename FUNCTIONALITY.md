# mox — Implemented Functionality

TUI email client. Bun + TypeScript + OpenTUI/Solid. Pulls IMAP mail into a local SQLite corpus; browse, search, categorize, read. All logic in-process (no separate backend binary). Sources in `src/`.

## Architecture

```
IMAP (imapflow) ──► SQLite (bun:sqlite) ──► OpenTUI/Solid TUI
   mail.ts            db.ts                    app.tsx
   engine.ts          config.ts                index.tsx (entry)
   backend.ts         text.ts / paths.ts       mcp.ts (Claude tools)
```

- **Category lives ONLY in SQLite** — never written back to the mail server. Server is read-only except one op (`\Seen` flag).
- **Two entry points:** `bun src/index.tsx` (TUI + flags, and `mox mcp`), `bun src/mcp.ts` (MCP server directly, dev only).
- **Paths** (config, `mox.db` in WAL mode, `backup/`, `Attachments/`) are resolved in `paths.ts`: repo root when running from source, `~/Documents/mox` when installed. README owns the user-facing details.

## Files

| File           | Role                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------- |
| `index.tsx`    | Entry. Resolves config + db, snapshots the store, dispatches the flags (`--version`, `--help`, `upgrade`, `--reclassify`, `--stats`, `--prefill`) and `mox mcp`, else renders the TUI. |
| `app.tsx`      | The whole TUI: sidebar, list, reading pane, keybindings, mouse, pickers, search input.      |
| `db.ts`        | SQLite store. Schema, migrations, search query builder, all reads/writes.                   |
| `mail.ts`      | IMAP layer. Connection pool, UID-incremental sync, folder detection, BODYSTRUCTURE attachment metadata, attachment fetch, draft append. |
| `config.ts`    | `config.yaml` parsing, sender-rule matching, rule persistence.                              |
| `backend.ts`   | Action layer the TUI and MCP server both call (sync/mark/move/rule/attachments).             |
| `paths.ts`     | Single source of truth for config, db, backup and attachment locations.                      |
| `engine.ts`    | Fetch orchestration + deterministic rule-filing.                                            |
| `backup.ts`    | Scheduled `VACUUM INTO` snapshots of the store into `backup/`, pruned to the newest N.       |
| `mcp.ts`       | MCP server: search/read, triage, categorize, download attachments, draft replies.           |
| `compose.ts`   | Draft MIME builder (multipart/alternative, wrapped in multipart/mixed when there are attachments); drafts are appended to IMAP Drafts, never sent. |
| `links.ts`     | Numbered-link extraction from lynx output (and bare URLs in plain text) for the link picker. |
| `text.ts`      | Width-safe text fitting (string-width), emoji presentation normalization.                   |
| `clipboard.ts` | System clipboard write via the first available platform tool (`pbcopy`/`wl-copy`/`xclip`/`xsel`). |

---

## Features

### 1. Multi-account IMAP sync

- N accounts from `config.yaml` (currently 2 Yahoo + 1 Gmail).
- **Connection pool** (`mail.ts`): one kept-alive connection per account; TUI pre-warms at startup so first refresh is fast. Login (TLS+AUTH+ID) is the dominant cost — pooling makes every refresh after the first just SELECT + UID-search.
- **UID-incremental sync:** cold backfill (count-based OR date-windowed via `fetch_since_days`), then forward-only for new arrivals.

### 2. Local SQLite corpus

- `messages` table: account, mailbox, uid, message_id, from, subject, date, snippet, **body, html**, attachments (JSON metadata), seen, **category, source, classified_at**.
- Full body + HTML stored — offline, portable, the foundation for AI operating on mail.
- Indexes on category, (mailbox,date), (account,mailbox,date).
- `sync_state` (per account+mailbox UID cursor), `approved_categories`.
- List queries capped at 1000 rows (2000 for search) for render speed.

### 3. Categorization (rule-based only — **AI NOT wired**)

- **Manual sender rules** in `config.yaml`: match by domain (subdomains included) or exact address. Deterministic. New mail is filed on every fetch/`r`; re-file existing mail after editing rules with `mox --reclassify`.
- 12 categories defined with AI-intent descriptions (Alerts, GitHub, Work, Finance, Bills, Shopping, Travel, Social, Newsletters, Notifications, Personal, Other).
- Rule match → sets category with source `rule`. No match → `Uncategorized`.
- **In-app rule creation (`A`):** pick messages → choose category → derives sender domains → writes rule to `config.yaml` (comment-preserving) → re-homes matching INBOX mail.
- **Manual move (`m`):** set category on selected messages, source `manual`.
- ⚠️ **`Suggested` category + AI descriptions exist in schema/config but NOTHING populates them.** `engine.ts` has zero AI. This is the stub hook point for the "let Claude Code categorize" vision.

### 4. Search (neomutt-style)

Space-separated AND-ed terms, quoted phrases, field operators (`db.ts` `buildSearch`):

- `from:` `subject:`/`subj:` `body:` — field-scoped
- `is:unread` / `is:read`
- `has:attachment`
- `in:inbox|sent|spam|archive`
- bare words → match subject OR sender OR body
- SQL LIKE with `%_\` escaping. `/` opens search input; `esc` clears.

### 5. TUI (OpenTUI/Solid)

- **3-pane layout:** sidebar (All / Mailboxes / Manual / Other / Folders with live counts) · message list · reading pane.
- **Message list:** per-row flags (select · done · unread) + a 📎 column marking messages that carry attachments (metadata from `BODYSTRUCTURE`, no downloads).
- **Reading pane:** header (from/subject/date/category/attachments) + body. **HTML auto-rendered via `lynx`** to flowing text, cached per email+width. Plain-text fallback.
- **Multi-select** (space) for bulk move/mark/rule.
- **Windowed scrolling** in list, sidebar, and picker (handles long URL lists).
- **Mouse:** wheel scroll, click-to-select, click-current-row-to-open, and drag-to-select text in the reader (releasing copies it).
- **Width-safe rendering** (`text.ts`): measures with the same `string-width` OpenTUI lays out with, forces emoji presentation (VS16) — prevents row-wrap corruption during rapid scroll.
- **Anti-flicker:** OpenTUI's native renderer owns the alt screen and synchronized output, and repaints only changed cells.

### 6. External viewers

- **`v`** — open email as HTML in browser (writes temp file, `open`).
- **`i`** — preview in `bat` (paged, themed; lynx-renders HTML first; handles alt-screen handoff + repaint).
- **`u`** — urlview-style URL picker: extract+dedup URLs from html+body (max 50), pick → `open` in browser.

### 7. Server writes (minimal)

- **`M`/`U`** — mark read/unread: writes `\Seen` to the server (grouped by account+folder), mirrors locally. **Only server-mutating op.**

### 8. Headless surface (`mcp.ts`, `index.tsx` flags)

- `mox mcp` — MCP server on stdio: `get_inbox`, `search_emails`, `get_email`, `triage_emails`, `set_category`, `create_draft`, `download_attachments`.
  - `create_draft` also takes `attachments`, a list of absolute (or `~/`) paths. `backend.readAttachments` reads the bytes and guesses the content type from the extension, before any IMAP call — a path must resolve (symlinks included) under the home or temp directory, must not contain a hidden dotfile segment, and must be at most 20 MB, with the attachments of one draft capped at 25 MB in total; `compose.buildDraftMime` then wraps the multipart/alternative body in a multipart/mixed envelope, one part per file.
- `mox --prefill` — whole-inbox metadata sweep + full bodies for the offline categories. The heavy seed.
- `mox --reclassify` / `mox --stats` — re-file against current rules, or print a store snapshot. No network for either.
- There is no separate CLI entry point. `r` in the TUI covers routine syncing (INBOX + Sent).

---

## Keybindings

| Key               | List mode                   | Reading mode     |
| ----------------- | --------------------------- | ---------------- |
| `j`/`k` `↓`/`↑`   | move cursor / scroll        | next/prev email  |
| `enter`           | open email                  | —                |
| `h`/`l` `tab`     | switch sidebar↔list focus   | —                |
| `d`/`u`           | half-page down/up           | half-page scroll |
| `g`/`G`           | goto picker / bottom        | start/end of email |
| `t`               | trash                       | trash            |
| `z`               | restore (undone/unarchive/untrash) | restore   |
| `space`           | toggle select               | —                |
| `/`               | search input                | —                |
| `esc`             | clear select / clear search | back to list     |
| `r`               | refresh (INBOX)             | —                |
| `m`               | move to category            | —                |
| `A`               | create sender rule          | —                |
| `M`/`U`           | mark read/unread            | mark read/unread |
| `v`               | open HTML in browser        | HTML in browser  |
| `o`               | —                           | numbered-link picker |
| `y`               | copy field (i/f/s/a)        | copy mode (char cursor, v select, y line, i/f/s/a) |
| `q`               | quit                        | back to list     |

---

## Gaps vs your vision (Claude-managed email)

| Want                                      | Status                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Fast scan UI + search + categories        | ✅ built (rules + search + TUI)                                                                                  |
| SQLite corpus for portability             | ✅ built (full body+html stored)                                                                                 |
| **AI categorization**                     | ❌ stubbed only — `Suggested`/descriptions exist, no code calls a model                                          |
| **AI reply drafting**                     | ⚠️ half - `create_draft` (MCP) builds the MIME (attachments included) and appends it to IMAP Drafts; nothing generates the text on its own |
| **Learn from your templates**             | ❌ not started                                                                                                   |
| Headless surface for Claude Code to drive | ✅ built — `mox mcp` exposes read, triage, categorize, attachments and draft replies                              |

## Known stale/rough spots

- `config.example.yaml` SMTP fields are placeholders and **unused** — mox appends drafts to IMAP Drafts and never sends.
