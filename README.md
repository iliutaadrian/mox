# spark-cli

A terminal email client with AI-powered, **Spark-style categorization**. It
fetches your mail over IMAP, sorts each message into a fixed set of categories
using Claude, and presents a LazyGit-style three-pane inbox grouped by category.

> **Categorize, not label.** The AI category lives only in a local SQLite
> database. spark-cli **never writes anything back to the mail server** — no
> labels, no folder moves, no flag changes. Your mailbox is untouched; the
> categorization is purely how this client chooses to display it, exactly like
> Spark's Smart Inbox.

## Features (v1)

- **Multiple IMAP accounts**, read-only, UID-incremental fetch.
- **AI classification** into a fixed category set you define. The model picks
  one category per email; when nothing fits, it **proposes a new category**
  that you approve with a keypress (it then joins your set).
- **Manual (rule-based) categories** — give a category a `match` of sender
  domains/addresses and matching mail is filed there deterministically, before
  the AI runs (no token cost). Create rules by hand in `config.yaml` or in-app
  by selecting emails and pressing `A`. Manual and AI categories show as
  separate sections in the sidebar.
- **On-demand** classification — press `r` to fetch new mail and classify it.
  Already-classified messages are skipped, so refreshes are cheap.
- **Three-pane TUI**: category sidebar │ message list │ reading pane.

Reply drafts (AI-written, never auto-sent) are the planned next milestone — the
SMTP config fields are already in place for them.

## Install

```bash
go build -o spark-cli ./cmd/spark-cli
```

## Configure

```bash
cp config.example.yaml config.yaml   # lives in the project folder for now
$EDITOR config.yaml
```

Set your IMAP accounts and the category set. For Gmail, use an
[App Password](https://support.google.com/accounts/answer/185833), not your
account password.

## Run

```bash
export OPENAI_API_KEY=sk-...   # required for classification
./spark-cli
```

By default spark-cli reads `./config.yaml` and creates the local database alongside
it (`./spark-cli.db`). Override either with `--config` and `--db`.

## Keys

The inbox opens as a **full-width list** (no auto-preview). Press `enter` to open
the highlighted email in a reading view; `esc`/`q` returns to the list.

**List view**

| Key            | Action                                                  |
| -------------- | ------------------------------------------------------- |
| `enter`        | Open the highlighted email                              |
| `r`            | Fetch new mail + classify                               |
| `tab` / `h` `l`| Switch focus between sidebar and message list           |
| `j` / `k` (↑↓) | Move within the focused pane                            |
| `space`        | Select / deselect a message (LazyGit-style multi-select)|
| `R`            | AI re-categorize the selected (or highlighted) messages |
| `m`            | Manually move the selection to a category               |
| `A`            | Create a sender rule from the selection → a category    |
| `M` / `U`      | Mark selection read / unread **on the server**          |
| `p`            | Approve the AI's suggested category for a message       |
| `esc`          | Clear the selection                                     |
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
account, shown when you have more than one) to explore a single mailbox; and the
category buckets split into **Manual** (rule-based) and **AI** sections. Category
buckets span all mailboxes. The reading view shows each email's `Mailbox` so you
can tell accounts apart. Bulk actions operate on the space-selected messages, or
the highlighted one if nothing is selected.

The **Suggested** bucket collects messages whose best category the AI thinks is
new. Select one and press `p` to promote that category into your fixed set —
every message proposing it moves into the new category, and future emails can
be sorted there.

## How it works

```
IMAP (read-only)  →  local SQLite (message + AI category column)
                            ↓
                  OpenAI classifies → category written LOCALLY only
                            ↓
                  TUI groups the inbox by category (Spark-style)
```

- `internal/config` — YAML config (accounts, categories, model).
- `internal/store`  — SQLite; the AI category is a local-only column.
- `internal/mail`   — go-imap/v2 fetch + MIME parsing. Read-only.
- `internal/ai`     — OpenAI classification via a batched, enum-constrained function call.
- `internal/engine` — orchestration: fetch → classify → persist.
- `internal/tui`    — Bubble Tea interface.

### Model & cost

Defaults to `gpt-4o-mini`, which is cheap and ample for this simple, high-volume
task. Set `model: gpt-4o` in the config for higher accuracy at more cost. The
classifier batches up to 20 emails per request and keeps the system prompt
byte-stable so OpenAI's automatic prompt cache kicks in on repeated refreshes.
