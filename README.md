# mox

A fast terminal email client with **Spark-style categorization**, written in
TypeScript ([OpenTUI](https://github.com/sst/opentui)/[Solid](https://www.solidjs.com) on [Bun](https://bun.sh)). It fetches your mail over IMAP
into a local SQLite store, files each message by deterministic rules, and shows
a three-pane inbox grouped by category.

> **Categorize locally.** Categories live only in the local SQLite database —
> no labels or folders are created on the server. The only server writes are the
> explicit triage actions: mark read/unread (`M`/`U`), archive (`a`), and trash
> (`d`), each with an inverse (`u`). Marking an email **done** (`e`) is
> local-only and never touches the server.

No AI/LLM in the client — categorization is rule-based and instant. Anything a
rule doesn't claim lands in **Uncategorized**; sort it externally (e.g. Claude
Code operating on the SQLite store) if you want. No API keys required.

## Install

Requires [Bun](https://bun.sh). Optional: `lynx` (HTML→text in the reading pane)
and `bat` are not required. `open` is used to launch links/HTML in a browser.

```bash
bun install
```

**Run from source (dev):**

```bash
./mox              # launcher → bun src/index.tsx (uses ./config.yaml)
```

**Install as a standalone binary (like neomutt):**

```bash
bun run install-bin        # builds + installs to ~/.local/bin/mox
# or choose a location:
PREFIX=/usr/local/bin bun run install-bin
```

`bun run build` alone produces `dist/mox`, a single self-contained executable
(no Bun or node_modules needed at runtime).

## Configure

```bash
cp config.example.yaml config.yaml   # dev: keep it at the repo root
# installed binary looks in ~/.config/mox/config.yaml
$EDITOR config.yaml
```

Config lookup order: `$MOX_CONFIG` → `./config.yaml` (repo, dev) →
`~/.config/mox/config.yaml`. The SQLite store is created next to the
config (`$MOX_DB` overrides). For Gmail/Yahoo use an **App Password**.

Categories are matched top-to-bottom; the first `match` that claims a message
wins, so **order is precedence**. A `match` supports:

```yaml
- name: Work
  match:
    domains:   [company.com]              # sender domain (also matches subdomains)
    addresses: [alerts@honeybadger.io]    # exact sender address
    words:     [invoice, standup]         # case-insensitive substring of SUBJECT or SENDER NAME
```

Categories without a `match` are manual-only buckets. `inbox_exclude: [Muted]`
keeps noisy categories out of INBOX and ALL (still reachable via their own
entry).

## Refresh & headless

`r` refreshes the **INBOX** (fast: pooled, pre-warmed IMAP connections) and
reconciles **Trash/Archive** (drops local rows removed on the server). Deeper
folder syncs / backfills run headless:

```bash
bun src/cli.ts sync                 # fetch ALL folders + rule-file, exit
bun src/cli.ts attach <id> [name]   # download an attachment on demand
```

## Keys

**List view**

| Key             | Action                                             |
| --------------- | -------------------------------------------------- |
| `enter`         | Open the highlighted email                         |
| `j`/`k` (↑↓)    | Move cursor / scroll                               |
| `tab` / `h` `l` | Switch focus between sidebar and list              |
| `space`         | Select / deselect (multi-select)                   |
| `e`             | **Done** — hide from INBOX (local only)            |
| `a`             | **Archive** on the server                          |
| `d`             | **Trash** on the server                            |
| `u`             | **Restore** — undone / unarchive / untrash         |
| `m`             | Move the selection to a category                   |
| `M` / `U`       | Mark read / unread **on the server**               |
| `/`             | Full-text search (`from:` `subject:` `is:unread` …)|
| `r`             | Fetch new mail + reconcile Trash/Archive           |
| `esc`           | Clear selection / search                           |
| `q`             | Quit                                               |

**Reading view**

| Key          | Action                                  |
| ------------ | --------------------------------------- |
| `j` / `k`    | Scroll the email                        |
| `h` / `l`    | Previous / next email                   |
| `v`          | Open the full HTML email in the browser |
| `D`          | Download attachments (folder if multiple) to ~/Downloads |
| `e`/`a`/`d`  | Done / archive / trash                  |
| `u`          | Restore (in Trash/Archive/done)         |
| `M` / `U`    | Mark read / unread on the server        |
| `esc` / `q`  | Back to the list                        |

**Sidebar:** **INBOX** (active, undone only) · **Mailboxes** (ALL + per-account,
show everything with a `✓` on done mail) · **Filters** (your categories) ·
**Other** (Uncategorized etc.) · **Folders** (Sent / Spam / Archived / Trash).

## How it works

```
IMAP  →  local SQLite (body + html + local category/done columns)
              ↓
        config rules file each INBOX message (first match wins)
              ↓
        OpenTUI/Solid TUI groups the inbox by category
```

- `src/config.ts` — YAML config: accounts, categories, `match` rules.
- `src/db.ts`     — bun:sqlite store; category/done are local-only columns.
- `src/mail.ts`   — imapflow fetch + mailparser; pooled connections; server moves.
- `src/engine.ts` — fetch → rule-file → persist.
- `src/backend.ts`— in-process actions (sync/mark/move/archive/trash + inverses).
- `src/app.tsx`   — OpenTUI/Solid interface.
- `src/cli.ts`    — headless entry (`sync`, `attach`).
