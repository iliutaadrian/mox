# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Draft composing without SMTP: `cli.ts draft` and the MCP `create_draft` tool
  build a nicely formatted message (plain text + generated HTML, UTF-8-safe
  headers/body) and append it to the account's IMAP Drafts folder with `\Draft`.
  Either a threaded reply to a stored message (`--reply-to <id>` derives the
  account, To and `Re:` subject, and sets In-Reply-To/References) or standalone
  (`--account/--to/--subject`). mox never sends — drafts are reviewed and sent
  from the provider's own UI.
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

### Changed
- Keybindings: **trash moved from `d` to `t`** and **restore from `u` to `z`**,
  freeing `d`/`u` for half-page down/up in both the list and the reader. The
  reader also gained `g`/`G` to jump to the start/end of an email. In the list
  `g` still opens the goto picker (`gg` jumps to the top, `G` to the bottom).
- Interactive refresh (`r`) now syncs **Sent** alongside INBOX, so replies sent
  from the provider's UI show up locally without a full `cli sync`.
- `s` saves attachments to `./Attachments` (under the directory mox was
  launched from) instead of `~/Downloads`.

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

[Unreleased]: https://github.com/iliutaadrian/mox/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/iliutaadrian/mox/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/iliutaadrian/mox/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/iliutaadrian/mox/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/iliutaadrian/mox/releases/tag/v1.0.0
