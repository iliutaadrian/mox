# spark-cli

A fast terminal email client with **Spark-style categorization**. It fetches
your mail over IMAP, files each message by deterministic sender rules, and
presents a LazyGit-style three-pane inbox grouped by category.

> **Categorize, not label.** The category lives only in a local SQLite
> database. spark-cli **never writes anything back to the mail server** — no
> labels, no folder moves, no flag changes (except an explicit read/unread on
> `M`/`U`). Your mailbox is otherwise untouched; the categorization is purely
> how this client chooses to display it, like Spark's Smart Inbox.

There is **no AI/LLM in the client** — categorization is rule-based and instant.
Anything a rule doesn't claim lands in **Uncategorized**; sort it externally
(e.g. with Claude Code driving the headless flags below) if you want.

## Two front-ends

- **Go TUI** (`./spark-cli`) — Bubble Tea, the original.
- **spark-ink** (`bun ink/src/index.tsx`) — Ink/React, adds mouse + search.

Both read the same `spark-cli.db`. spark-ink shells out to the Go binary for
every write (fetch, mark, move) so there is one writer implementation.

## Features

- **Multiple IMAP accounts**, read-only, UID-incremental fetch (fast refresh).
- **Rule-based categories** — give a category a `match` of sender
  domains/addresses and matching mail is filed there deterministically. Create
  rules in `config.yaml` or in-app: select emails (`space`) and press `A`.
- **Full-text search** (spark-ink): press `/`, search subject/sender/body.
- **Mouse** (spark-ink): click to select, wheel to scroll.
- **Three-pane TUI**: category sidebar │ message list │ reading pane.

## Install

```bash
go build -o spark-cli ./cmd/spark-cli      # Go TUI + backend
cd ink && bun install                      # spark-ink deps (optional)
```

## Configure

```bash
cp config.example.yaml config.yaml
$EDITOR config.yaml
```

Set your IMAP accounts and the category set. For Gmail, use an
[App Password](https://support.google.com/accounts/answer/185833), not your
account password. No API keys or environment variables are required.

## Run

```bash
./spark-cli                 # Go TUI
bun ink/src/index.tsx       # spark-ink (from repo root)
```

By default spark-cli reads `./config.yaml` and creates the local database
alongside it (`./spark-cli.db`). Override with `--config` and `--db`.

### Headless backend

For scripts or an external categorizer, the Go binary exits after one action:

| Flag                          | Action                                    |
| ----------------------------- | ----------------------------------------- |
| `-fetch`                      | Fetch + store new mail only               |
| `-sync`                       | Fetch + file by rules                     |
| `-mark read\|unread -ids …`   | Set \Seen on the server for db ids        |
| `-move <category> -ids …`     | Manually move db ids to a category        |

## Keys

The inbox opens as a **full-width list** (no auto-preview). Press `enter` to open
the highlighted email; `esc`/`q` returns to the list.

**List view**

| Key            | Action                                                  |
| -------------- | ------------------------------------------------------- |
| `enter`        | Open the highlighted email                              |
| `r`            | Fetch new mail + file by rules                          |
| `/`            | Search (spark-ink)                                      |
| `tab` / `h` `l`| Switch focus between sidebar and message list           |
| `j` / `k` (↑↓) | Move within the focused pane                            |
| `space`        | Select / deselect a message (LazyGit-style multi-select)|
| `m`            | Manually move the selection to a category               |
| `A`            | Create a sender rule from the selection → a category    |
| `M` / `U`      | Mark selection read / unread **on the server**          |
| `esc`          | Clear the selection (or search)                         |
| `q`            | Quit                                                    |

**Reading view** (after `enter`)

| Key            | Action                                                  |
| -------------- | ------------------------------------------------------- |
| `j` / `k`      | Next / previous email                                   |
| `ctrl+u/d`     | Scroll the email                                        |
| `v`            | Open the full HTML email in your browser                |
| `M` / `U`      | Mark read / unread on the server                        |
| `esc` / `q`    | Back to the list                                        |

The sidebar has an **All** view on top; a **Mailboxes** section (one entry per
account, shown when you have more than one); the rule categories under
**Manual**; and everything else under **Other** (manually-moved categories +
**Uncategorized**). Category buckets span all mailboxes.

## How it works

```
IMAP (read-only)  →  local SQLite (message + local category column)
                            ↓
                  sender rules file each message (deterministic)
                            ↓
                  TUI groups the inbox by category (Spark-style)
```

- `internal/config` — YAML config (accounts, categories).
- `internal/store`  — SQLite; the category is a local-only column.
- `internal/mail`   — go-imap/v2 fetch + MIME parsing. Read-only.
- `internal/engine` — orchestration: fetch → rule-file → persist.
- `internal/tui`    — Bubble Tea interface.
- `ink/`            — spark-ink (Ink/React) reading the same db.
