# Review checklist for mox

The gate reads this file from the branch under review, not from the default
branch. `.no-mistakes.yaml` is trusted from `main` only and carries the gate's
test and lint commands; the review rules themselves live here.

## Report nothing but defects

No praise. No summary of what the code does. No restatement of the diff. No
formatting or naming opinions. No proposals for new abstractions, wrappers,
service layers, or config options for a one-off need.

Rank by real user impact, worst first.

## Ranked defect classes

### 1. Reach into the real mailbox or the real store

The installed binary uses `~/Documents/mox/mox.db`. A source checkout uses the
repo's `./mox.db`. Tests must set `MOX_CONFIG` and `MOX_DB` and point the account
at an unroutable host.

A test or dev path that can touch the real store is the worst defect in this
repo, above anything else on this list. Check every new test file, every fixture,
and every manual verification step.

### 2. A server write that bypasses `backend()`

There must be exactly one implementation of trash, archive, read state and done.
A second path that writes to IMAP directly is a defect even when it works.

### 3. Silent failure

Swallowed exceptions. Empty catch blocks. A process that exits 0 after failing.
An error path that reports success.

`src/index.tsx` installs no-op `uncaughtException` and `unhandledRejection`
handlers for the TUI. Any code path that inherits those handlers and needs
diagnostics is a defect.

### 4. Documented but not shipped

`scripts/build.ts` compiles `src/index.tsx` only. A command, flag or tool
reachable only from another entry file does not exist for a user who installed
the binary. Check README claims against the build graph, not against source.

### 5. MCP tool descriptions that blur local and remote

A tool description must state whether the action is local only (`done`,
`category`) or a real IMAP move (trash, archive, read state). A model driving
these tools must not be able to confuse the two.

### 6. Concurrency and connection handling

An IMAP client used after a reconnect replaced it. An unhandled EventEmitter
error. A pooled connection left in the pool after it died.

### 7. SQLite

A query built by string interpolation. A write outside a transaction where the
batch matters. A schema change with no migration.

## Deliberate choices, not findings

Scope reduction is normal here. When the run intent says a command, flag or
entry point was removed on purpose, the removal is not missing functionality.

Apple Silicon only releases are deliberate. Intel and Linux users build from
source.

No linter and no formatter. `bun run typecheck` is the whole lint gate.
