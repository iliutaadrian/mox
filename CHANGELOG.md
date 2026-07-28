# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-07-28

### Added
- Draft composing without SMTP: the MCP `create_draft` tool builds a nicely
  formatted message (plain text + generated HTML, UTF-8-safe headers/body) and
  appends it to the account's IMAP Drafts folder with `\Draft`. Either a threaded
  reply to a stored message (`reply_to` derives the account, To and `Re:`
  subject, and sets In-Reply-To/References) or standalone (`account`/`to`/
  `subject`). mox never sends — drafts are reviewed and sent from the provider's
  own UI.
- `mox mcp` runs the MCP server straight from the installed binary, so
  registering it needs no source checkout and no Bun:
  `claude mcp add -s user mox -- mox mcp`.
- The reading pane header shows the message `Id:` — the same id the MCP tools
  take, so a message on screen can be handed straight to Claude.
- `Store.full()` now exposes the message's `message_id` (used for reply threading).

### Added (copy mode)
- Copy mode (`y`) with a real system-clipboard write (`pbcopy`, or
  `wl-copy`/`xclip`/`xsel` elsewhere). In the reader it puts a character cursor
  on the pane: `h`/`j`/`k`/`l` move it, `0`/`$` and `g`/`G` jump to the ends;
  `y` copies the cursor's line, and `v` starts a selection that `y` then copies
  (character-precise, across lines).
- Mouse drag selects text in the reader and copies it on release — no mode to
  enter. Selections are rendered by OpenTUI itself, so the highlight is exactly
  what lands on the clipboard; trailing pane padding is stripped.
- One-key field copies work from both the list and the reader: `i` id, `f`
  sender address, `s` subject, `a` the whole email (or one tab-separated row per
  message from the list). These act on the multi-selection, so `space`-marking
  rows then `yi` yields every id, one per line.

### Added (numbered links)
- Reader link picker (`o`): email bodies render with lynx's `[N]` link
  references inline (no more raw URL dump at the bottom), and `o` opens a
  filterable picker over them - type the number, label text or domain, enter
  opens the link in the browser. Tracking-looking links are tagged. Plain-text
  emails get the same treatment by numbering their bare URLs. Shared logic
  lives in `src/links.ts`.

### Added (MCP actions)
- The MCP server can now triage mail, not just read it: `get_inbox` (active
  undone mail), `triage_emails` (done/undone, trash/untrash, archive/unarchive,
  read/unread over one or many ids), `set_category` (by ids, or every message
  from one sender), and `download_attachments`. `create_draft` is retitled and
  reworded so "respond to this email" reaches for it.
- Tool descriptions state which actions are local-only (`done`, category) and
  which are real IMAP moves (trash, archive, read/unread), so a model driving
  them cannot confuse the two.
- `Store.setCategoryBySender()` and `backend().done()` / `backend().moveBySender()`
  back these; `setDone()` now returns how many rows actually changed so a tool
  reports real work instead of the size of the id list it was handed.

### Added (backups)
- Scheduled snapshots of the SQLite store into a `backup/` folder next to the
  database, written with `VACUUM INTO` (a file copy of a WAL database can miss
  recent writes). Configurable via `backup_enabled` / `backup_every_hours` /
  `backup_keep` (defaults: on, 12 hours, keep 2). The schedule is stateless - it
  compares the newest existing snapshot's timestamp - so it survives restarts,
  and a failed backup never blocks the app from starting.

### Added (tests)
- A test suite: `bun run check` (typecheck + tests, ~7s), `bun run test:unit`,
  `bun run test:e2e`. 86 tests over the store, width/copy helpers, draft MIME,
  numbered links, and the TUI itself.
- The end-to-end tests mount the real `<App/>` in OpenTUI's in-process test
  renderer and drive it with real key and mouse events, asserting on the painted
  screen (`test/helpers/tui.ts`). Each test runs against a throwaway fixture
  mailbox pointed at an unroutable host (`test/helpers/fixture.ts`), so the suite
  never touches the real mailbox.
- `tidyCopy()` moved into `src/text.ts` so the copy-padding rule is unit-tested;
  it now also preserves a selection that is entirely whitespace.

### Removed
- MCP `list_emails` and `email_stats` tools; `search_emails` covers both
  (`in:` and category filters) and the surface stays smaller.
- The headless CLI entry point (`src/cli.ts`) and its `sync` / `offline` /
  `attach` / `draft` commands. It only ever ran from a source checkout, and
  everything it did is reachable from the two surfaces that ship: the TUI (`r`
  refreshes INBOX + Sent, `s` saves attachments, `mox --prefill` seeds the whole
  inbox) and the MCP tools (triage, categories, attachments, drafts). One fewer
  entry point, one fewer argument parser, no duplicate IMAP paths.
- `fetchAttachment()` in `mail.ts` — the single-named-attachment fetch had no
  callers left once `attach` went; `fetchAllAttachments()` covers every case.

### Changed
- Keybindings: **trash moved from `d` to `t`** and **restore from `u` to `z`**,
  freeing `d`/`u` for half-page down/up in both the list and the reader. The
  reader also gained `g`/`G` to jump to the start/end of an email. In the list
  `g` still opens the goto picker (`gg` jumps to the top, `G` to the bottom).
- Interactive refresh (`r`) now syncs **Sent** alongside INBOX, so replies sent
  from the provider's UI show up locally without a full `mox --prefill`.
- `s` saves attachments into an `Attachments/` folder next to the database
  (`~/Documents/mox` when installed, the repo root in dev) instead of
  `~/Downloads`. The MCP `download_attachments` tool writes to the same folder,
  so a server Claude Code spawned inside some other project cannot drop mail
  attachments into it.

### Fixed
- The reading pane no longer scrolls past the end of an email: `j` and the mouse
  wheel stop once the last line (the References tail, when there is one) is on
  screen, instead of running the content off into blank space.

## [1.3.0] - 2026-07-23

### Added
- Attachment metadata captured from IMAP `BODYSTRUCTURE` on every sync (no bytes
  downloaded); the message list marks mail carrying files with a 📎.
- `mox --reclassify` — re-file the whole inbox against the current config rules
  (manual moves preserved), no network.
- `mox --stats` — snapshot of downloaded/offline-readable mail, broken down by
  category, mailbox and top senders.
- `mox --help` / `-h` — print usage.
- `mox --prefill` now shows live per-account progress (bodies/index/new mail)
  and reports incomplete accounts instead of silently swallowing failures.

### Changed
- Save attachments in the reading pane with `s` (was `D`).
- Prefill is dramatically faster and more resilient: batched inserts in a single
  transaction (`PRAGMA synchronous = NORMAL` under WAL) and a chunked whole-inbox
  metadata sweep with per-chunk reconnect + retry, so a dropped connection
  resumes where it stopped rather than aborting the seed.

### Fixed
- Prefill no longer marks a whole account failed after a mid-sweep reconnect:
  `syncAll` re-acquires the pooled connection per folder instead of reusing a
  reference the reconnect had replaced.

## [1.2.0] - 2026-07-23

### Added
- `mox --version` / `-v` — print the installed version.
- `mox upgrade` — download and install the latest release in place (re-runs the
  canonical installer against the running binary's directory).

## [1.1.0] - 2026-07-23

### Added
- `mox --prefill`: one-time headless bulk seed. Sweeps envelope-only metadata
  over the entire INBOX (whole inbox searchable offline; bodies fetched on
  demand), and caches full bodies for the `offline_categories`. A normal launch
  still pulls only the recent `fetch_limit` with full content.
- Reading pane now shows the recipient (`To:`) address — the account's own
  address that received the message.

### Changed
- Offline-category backfill now bulk-fetches bodies per account (chunked UID
  FETCH) with a two-pass retry, instead of one fragile request per message.

### Removed
- CI typecheck workflow (`.github/workflows/ci.yml`); type checking is run
  locally until a proper lint + test suite is added.

## [1.0.0] - 2026-07-23

First public release.

### Added
- Fast three-pane terminal email client (OpenTUI/Solid on Bun) with a
  category sidebar, message list and reading pane.
- Deterministic, rule-based local categorization — no AI/LLM, no API keys.
  Categories live only in the local SQLite store; no server-side labels or
  folders are created.
- IMAP sync into a local SQLite database, with on-demand body fetch and
  configurable content retention (`content_days`, `fetch_since_days`).
- Triage actions with inverses: mark read/unread, archive, trash, and a
  local-only "done" state; multi-select and a type-to-filter move picker.
- Goto shortcuts and unread navigation (`g`, `n`/`p`, `gg`/`G`), live search.
- Attachment download (single and per-email subfolder).
- Read-only MCP server exposing mail search/get/list/stats to Claude.
- Prebuilt macOS binary (Apple Silicon) and a `curl | bash` installer;
  single-folder data directory at `~/Documents/mox`.

[Unreleased]: https://github.com/iliutaadrian/mox/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/iliutaadrian/mox/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/iliutaadrian/mox/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/iliutaadrian/mox/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/iliutaadrian/mox/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/iliutaadrian/mox/releases/tag/v1.0.0
