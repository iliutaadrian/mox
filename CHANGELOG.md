# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/iliutaadrian/mox/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/iliutaadrian/mox/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/iliutaadrian/mox/releases/tag/v1.0.0
