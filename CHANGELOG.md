# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/iliutaadrian/mox/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/iliutaadrian/mox/releases/tag/v1.0.0
