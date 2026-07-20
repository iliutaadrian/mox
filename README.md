# spark-cli

A fast terminal email client with **Spark-style categorization**, written in
TypeScript (Ink/React on [Bun](https://bun.sh)). It fetches your mail over IMAP,
files each message by deterministic sender rules, and presents a LazyGit-style
three-pane inbox grouped by category.

> **Categorize, not label.** The category lives only in a local SQLite
> database. spark-cli **never writes anything back to the mail server** — no
> labels, no folder moves, no flag changes (except an explicit read/unread on
> `M`/`U`). Your mailbox is otherwise untouched; the categorization is purely
> how this client chooses to display it, like Spark's Smart Inbox.

No AI/LLM: categorization is rule-based and instant. Anything a rule doesn't
claim lands in **Uncategorized**; sort it externally (e.g. Claude Code) if you
want. No API keys or environment variables required.

## Features

- **Multiple IMAP accounts**, read-only, UID-incremental fetch (fast refresh).
- **All folders**: INBOX plus **Sent / Spam / Archive** (auto-detected via IMAP
  special-use), browsable in the sidebar.
- **Rule-based categories** — give a category a `match` of sender
  domains/addresses; matching mail is filed there deterministically. Create
  rules in `config.yaml` or in-app (`A`).
- **Full-text search** (`/`) over subject, sender, body.
- **Mouse**: click to select, wheel to scroll.
- **Inline email preview** (`i`): renders the real HTML email to an image and
  paints it in the terminal — true images in a graphics terminal (Ghostty/kitty)
  via `chafa` + Chrome/Chromium, block-art elsewhere.
- **Three-pane TUI**: category sidebar │ message list │ reading pane.

## Install

```bash
cd ink && bun install && cd ..
```

Requires [Bun](https://bun.sh). Optional for inline preview: `chafa` and
Chrome/Chromium.

## Configure

```bash
cp config.example.yaml config.yaml
$EDITOR config.yaml
```

Set your IMAP accounts and the category set. For Gmail, use an
[App Password](https://support.google.com/accounts/answer/185833), not your
account password.

## Run

```bash
./spark                 # launcher (bun ink/src/index.tsx)
```

The db is created next to `config.yaml` (`./spark-cli.db`) on first run. IMAP
connections are pooled and pre-warmed at startup, so `r` refreshes fast.

In-app `r` refreshes the **INBOX** only (fast). **Sent/Spam/Archive** change
rarely — refresh them (and do bulk backfills after raising `fetch_since_days`)
headless:

```bash
bun ink/src/cli.ts sync                 # fetch ALL folders + rule-file, exit
bun ink/src/cli.ts attach <id> [name]   # download an attachment on demand
```

## Keys

The inbox opens as a **full-width list**. Press `enter` to open the highlighted
email; `esc`/`q` returns to the list.

**List view**

| Key            | Action                                                  |
| -------------- | ------------------------------------------------------- |
| `enter`        | Open the highlighted email                              |
| `i`            | Preview the real email inline as an image               |
| `/`            | Full-text search                                        |
| `r`            | Fetch new mail + file by rules                          |
| `tab` / `h` `l`| Switch focus between sidebar and message list           |
| `j` / `k` (↑↓) | Move within the focused pane                            |
| `space`        | Select / deselect (LazyGit-style multi-select)          |
| `m`            | Move the selection to a category                        |
| `A`            | Create a sender rule from the selection → a category    |
| `M` / `U`      | Mark selection read / unread **on the server**          |
| `esc`          | Clear the selection (or search)                         |
| `q`            | Quit                                                    |

**Reading view**

| Key            | Action                                                  |
| -------------- | ------------------------------------------------------- |
| `j` / `k`      | Next / previous email                                   |
| `ctrl+u/d`     | Scroll the email                                        |
| `i`            | Preview the real email inline as an image               |
| `v`            | Open the full HTML email in your browser                |
| `M` / `U`      | Mark read / unread on the server                        |
| `esc` / `q`    | Back to the list                                        |

The sidebar: **All** (INBOX across accounts) · **Mailboxes** (per-account INBOX,
if >1 account) · **Manual** (rule categories) · **Other** (manually-moved
categories + **Uncategorized**) · **Folders** (Sent/Spam/Archive across
accounts). Category buckets span all accounts.

## How it works

```
IMAP (read-only)  →  local SQLite (message + local category column)
                            ↓
                  sender rules file each INBOX message (deterministic)
                            ↓
                  TUI groups the inbox by category (Spark-style)
```

- `ink/src/config.ts` — YAML config (accounts, categories, rules).
- `ink/src/db.ts`     — bun:sqlite store; the category is a local-only column.
- `ink/src/mail.ts`   — imapflow fetch + mailparser MIME. Read-only (bar `M`/`U`).
- `ink/src/engine.ts` — orchestration: fetch → rule-file → persist.
- `ink/src/backend.ts`— in-process actions the TUI triggers (sync/mark/move/rule).
- `ink/src/app.tsx`   — Ink/React interface; `ink/src/preview.ts` renders inline images.
- `ink/src/cli.ts`    — headless entry (`sync`, `attach`).
