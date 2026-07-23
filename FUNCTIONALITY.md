# mox — Implemented Functionality

TUI email client. Bun + TypeScript + Ink/React. Pulls IMAP mail into a local SQLite corpus; browse, search, categorize, read. All logic in-process (no separate backend binary). ~1780 LOC across 10 files in `ink/src/`.

## Architecture

```
IMAP (imapflow) ──► SQLite (bun:sqlite) ──► Ink/React TUI
   mail.ts            db.ts                    app.tsx
   engine.ts          config.ts                index.tsx (entry)
   backend.ts         text.ts / mouse.ts       cli.ts (headless)
```

- **Category lives ONLY in SQLite** — never written back to the mail server. Server is read-only except one op (`\Seen` flag).
- **Two entry points:** `bun ink/src/index.tsx` (TUI), `bun ink/src/cli.ts <cmd>` (headless/scriptable).
- **DB path:** `mox.db` at repo root (WAL mode). Config: `config.yaml`.

## Files

| File         | LOC | Role                                                                                        |
| ------------ | --- | ------------------------------------------------------------------------------------------- |
| `index.tsx`  | 50  | Entry. Alt-screen wrapper, synchronized-output (DEC 2026) frame wrapping, force-clear hook. |
| `app.tsx`    | 614 | The whole TUI: sidebar, list, reading pane, keybindings, mouse, pickers, search input.      |
| `db.ts`      | 324 | SQLite store. Schema, migrations, search query builder, all reads/writes.                   |
| `mail.ts`    | 306 | IMAP layer. Connection pool, UID-incremental sync, folder detection, attachment fetch.      |
| `config.ts`  | 128 | `config.yaml` parsing, sender-rule matching, rule persistence.                              |
| `backend.ts` | 102 | Action layer the TUI calls (sync/mark/move/rule).                                           |
| `text.ts`    | 88  | Width-safe text fitting (string-width), emoji presentation normalization.                   |
| `mouse.ts`   | 59  | SGR mouse tracking (wheel + click), parsed off stdin.                                       |
| `engine.ts`  | 58  | Fetch orchestration + deterministic rule-filing.                                            |
| `cli.ts`     | 50  | Headless commands (`sync`, `attach`).                                                       |

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

- **Manual sender rules** in `config.yaml`: match by domain (subdomains included) or exact address. Deterministic, run on every sync.
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

### 5. TUI (Ink/React)

- **3-pane layout:** sidebar (All / Mailboxes / Manual / Other / Folders with live counts) · message list · reading pane.
- **Reading pane:** header (from/subject/date/category/attachments) + body. **HTML auto-rendered via `lynx`** to flowing text, cached per email+width. Plain-text fallback.
- **Multi-select** (space) for bulk move/mark/rule.
- **Windowed scrolling** in list, sidebar, and picker (handles long URL lists).
- **Mouse:** wheel scroll, click-to-select, click-current-row-to-open (`mouse.ts`, SGR tracking).
- **Width-safe rendering** (`text.ts`): measures with the same `string-width` Ink uses, forces emoji presentation (VS16) — prevents row-wrap corruption during rapid scroll.
- **Anti-flicker:** synchronized-output (DEC 2026) frames + no key-move throttle.

### 6. External viewers

- **`v`** — open email as HTML in browser (writes temp file, `open`).
- **`i`** — preview in `bat` (paged, themed; lynx-renders HTML first; handles alt-screen handoff + repaint).
- **`u`** — urlview-style URL picker: extract+dedup URLs from html+body (max 50), pick → `open` in browser.

### 7. Server writes (minimal)

- **`M`/`U`** — mark read/unread: writes `\Seen` to the server (grouped by account+folder), mirrors locally. **Only server-mutating op.**

### 8. Headless CLI (`cli.ts`)

- `sync` — full fetch across all folders + rule-file. For large backfills without blocking the UI.
- `attach <id> [name]` — re-fetch + download an attachment to cwd.

---

## Keybindings

| Key               | List mode                   | Reading mode     |
| ----------------- | --------------------------- | ---------------- |
| `j`/`k` `↓`/`↑`   | move cursor / scroll        | next/prev email  |
| `enter`           | open email                  | —                |
| `h`/`l` `tab`     | switch sidebar↔list focus   | —                |
| `ctrl+d`/`ctrl+u` | —                           | half-page scroll |
| `space`           | toggle select               | —                |
| `/`               | search input                | —                |
| `esc`             | clear select / clear search | back to list     |
| `r`               | refresh (INBOX)             | —                |
| `m`               | move to category            | —                |
| `A`               | create sender rule          | —                |
| `M`/`U`           | mark read/unread            | mark read/unread |
| `v`               | open HTML in browser        | HTML in browser  |
| `u`               | URL picker                  | URL picker       |
| `q`               | quit                        | back to list     |

---

## Gaps vs your vision (Claude-managed email)

| Want                                      | Status                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Fast scan UI + search + categories        | ✅ built (rules + search + TUI)                                                                                  |
| SQLite corpus for portability             | ✅ built (full body+html stored)                                                                                 |
| **AI categorization**                     | ❌ stubbed only — `Suggested`/descriptions exist, no code calls a model                                          |
| **AI reply drafting**                     | ❌ not started (SMTP in config but unused; `p` approve-suggestion referenced in config comment, not implemented) |
| **Learn from your templates**             | ❌ not started                                                                                                   |
| Headless surface for Claude Code to drive | ⚠️ partial — `cli.ts` has sync/attach only; no `classify`/`draft`/`export` commands                              |

## Known stale/rough spots

- `app.tsx:1-4` header comment still describes the **old Go backend** ("shells out to the Go binary", "no AI classification") — inaccurate now.
- Config comment mentions `p` to approve a `Suggested` category — **no `p` handler exists**.
- `config.yaml` SMTP fields are placeholders (`you@yahoo.com`) — reply feature not built.
- No tests anywhere.
