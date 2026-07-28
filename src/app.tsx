// mox TUI (OpenTUI/Solid). Sidebar (INBOX / Mailboxes / Filters / Other /
// Folders) + message list + reading view, all reading/writing the local SQLite
// store in-process. New mail is filed deterministically by config rules on
// fetch/`r` (re-file existing mail after a rule change with `mox --reclassify`);
// server writes are limited to mark-read, archive, trash and their inverses.
//
// Why Solid + OpenTUI (not React + Ink): OpenTUI keeps a persistent scene graph
// and repaints only the cells that change; Solid's fine-grained reactivity means
// a held j/k updates one signal and repaints two rows, not the whole tree. No
// per-frame reconcile, no full-frame stdout writes — that's what makes it fast.
import { useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/solid";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import { createSignal, createMemo, createEffect, onMount, onCleanup, For, Show, batch } from "solid-js";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store, FOLDER_CLASSES, type Filter, type MessageRow } from "./db.ts";
import { loadConfig, type Config } from "./config.ts";
import { backend } from "./backend.ts";
import { warmConnections } from "./mail.ts";
import { fit, oneLine, tidyCopy } from "./text.ts";
import { renderEmail, filterLinks, type RenderedEmail, type LinkRef } from "./links.ts";
import { copyToClipboard } from "./clipboard.ts";

const SIDEBAR_W = 26;
const PAGE = 200; // lazy-load window: rows fetched per view, grown as you scroll down
const PINK = "#5fd7ff"; // primary accent (header, focus borders, prompt) — powerline cyan
const BLUE = "#00afd7"; // secondary accent (section headers)
const DIM = "#9e9e9e";
const GRAY = "#4e4e4e"; // inactive borders — powerline gray
const CAT = "#5faf87"; // category label — muted teal-green
const DONE = "#87d787"; // ✓ marker for done mail (shown in non-inbox views)
const BLACK = "#1c1c1c"; // popup bg — powerline dark

type SideEntry =
  | { kind: "inbox"; label: string; exclude: string[] }
  | { kind: "all"; label: string; exclude: string[] }
  | { kind: "header"; label: string }
  | { kind: "account"; name: string; label: string; exclude: string[] }
  | { kind: "category"; name: string; label: string }
  | { kind: "folder"; cls: string; label: string };

function buildSidebar(store: Store, cfg: Config): SideEntry[] {
  const ex = cfg.inboxExclude;
  const accCounts = store.accountCounts(ex);
  const catCounts = store.categoryCounts();
  // INBOX = the active view (undone only). ALL + accounts live under Mailboxes
  // and show everything (done marked with a ✓). Excluded/muted categories are
  // kept out of INBOX/ALL/accounts — reachable via their own Filters entry.
  const entries: SideEntry[] = [
    { kind: "inbox", label: `INBOX (${store.inboxCount(ex)})`, exclude: ex },
  ];

  entries.push({ kind: "header", label: "Mailboxes" });
  entries.push({ kind: "all", label: `ALL (${store.allCount(ex)})`, exclude: ex });
  const accounts = cfg.accounts.map((a) => a.name).filter((n) => (accCounts.get(n) ?? 0) > 0);
  if (accounts.length > 1) {
    for (const a of accounts)
      entries.push({ kind: "account", name: a, label: `${a} (${accCounts.get(a)})`, exclude: ex });
  }

  // Every category defined in config.yaml shows under "Filters" (user-curated),
  // whether or not it has an auto-match rule (a ruleless one holds manual moves).
  const configNames = new Set(cfg.categories.map((c) => c.name));
  const manual = cfg.categories.filter((c) => (catCounts.get(c.name) ?? 0) > 0);
  if (manual.length > 0) {
    entries.push({ kind: "header", label: "Filters" });
    for (const c of manual)
      entries.push({ kind: "category", name: c.name, label: `${c.name} (${catCounts.get(c.name)})` });
  }

  // "Other" holds only non-config buckets: approved-but-unlisted, AI Suggested,
  // and Uncategorized.
  const other: string[] = [];
  for (const c of store.approvedCategories())
    if ((catCounts.get(c) ?? 0) > 0 && !configNames.has(c)) other.push(c);
  if ((catCounts.get("Suggested") ?? 0) > 0) other.push("Suggested");
  if ((catCounts.get("Uncategorized") ?? 0) > 0) other.push("Uncategorized");
  if (other.length > 0) {
    entries.push({ kind: "header", label: "Other" });
    for (const name of other)
      entries.push({ kind: "category", name, label: `${name} (${catCounts.get(name)})` });
  }

  const folderCounts = store.folderCounts();
  const folderRows = FOLDER_CLASSES.filter((c) => (folderCounts.get(c) ?? 0) > 0);
  if (folderRows.length > 0) {
    entries.push({ kind: "header", label: "Folders" });
    for (const c of folderRows)
      entries.push({ kind: "folder", cls: c, label: `${c === "Archive" ? "Archived" : c} (${folderCounts.get(c)})` });
  }

  return entries;
}

function filterOf(e: SideEntry): Filter {
  if (e.kind === "inbox") return { kind: "inbox", exclude: e.exclude };
  if (e.kind === "account") return { kind: "account", name: e.name, exclude: e.exclude };
  if (e.kind === "category") return { kind: "category", name: e.name };
  if (e.kind === "folder") return { kind: "folder", class: e.cls };
  return { kind: "all", exclude: e.kind === "all" ? e.exclude : [] };
}

// Case-insensitive substring filter for picker options (empty query = all).
function filterOpts(options: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  return q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
}

function nextSelectable(entries: SideEntry[], idx: number, dir: 1 | -1): number {
  let i = idx + dir;
  while (i >= 0 && i < entries.length) {
    if (entries[i]!.kind !== "header") return i;
    i += dir;
  }
  return idx;
}

// Move a viewport top so `idx` stays visible in a window of `height` rows,
// WITHOUT recentering on every step — mid-window moves leave `top` unchanged, so
// only the two affected rows repaint (the win that makes held keys smooth).
function follow(idx: number, top: number, height: number): number {
  if (idx < top) return idx;
  if (idx >= top + height) return idx - height + 1;
  return top;
}

export function App(props: { dbPath: string; cfgPath: string }) {
  const renderer = useRenderer();
  const dims = useTerminalDimensions();
  const store = new Store(props.dbPath);
  const cfg: Config = loadConfig(props.cfgPath);
  const be = backend(store, cfg);

  const [version, setVersion] = createSignal(0); // bump after writes to re-query
  const [catIdx, setCatIdx] = createSignal(0);
  const [msgIdx, setMsgIdx] = createSignal(0);
  const [focus, setFocus] = createSignal<"sidebar" | "list">("sidebar");
  const [mode, setMode] = createSignal<"list" | "reading">("list");
  const [selected, setSelected] = createSignal<Set<number>>(new Set<number>());
  const [status, setStatusRaw] = createSignal("Press r to fetch new mail");
  const [statusAt, setStatusAt] = createSignal(0); // epoch ms of the last status change
  const setStatus = (s: string) =>
    batch(() => {
      setStatusRaw(s);
      setStatusAt(Date.now());
    });
  const [busy, setBusy] = createSignal(false);
  const [scroll, setScroll] = createSignal(0);
  const [picker, setPicker] = createSignal<{ kind: "move" | "goto"; options: string[]; idx: number; query: string } | null>(null);
  const [search, setSearch] = createSignal<string | null>(null); // committed query
  const [searchAt, setSearchAt] = createSignal(0); // epoch ms of the last search commit
  const [typing, setTyping] = createSignal(false); // search input active
  const [draft, setDraft] = createSignal("");
  const [lastSync, setLastSync] = createSignal<number>(0); // epoch ms of last successful sync
  const [listTop, setListTop] = createSignal(0); // list viewport top row
  const [sideTop, setSideTop] = createSignal(0); // sidebar viewport top row
  const [limit, setLimit] = createSignal(PAGE); // rows loaded for the active view (grows on scroll)

  const bodyH = createMemo(() => Math.max(3, dims().height - 4));
  const listW = createMemo(() => Math.max(16, dims().width - SIDEBAR_W - 4));

  // Open IMAP connections in the background at startup so the first `r` refresh
  // doesn't pay the login cost.
  onMount(() => void warmConnections(cfg.accounts));

  const exit = () => {
    renderer.destroy();
    process.exit(0);
  };

  const entries = createMemo(() => {
    version();
    return buildSidebar(store, cfg);
  });
  const safeCatIdx = createMemo(() => Math.min(catIdx(), entries().length - 1));
  const entry = createMemo(() => {
    const es = entries();
    const i = safeCatIdx();
    return es[i]!.kind === "header" ? es[0]! : es[i]!;
  });
  const activeFilter = createMemo<Filter>(() =>
    search() !== null ? { kind: "search", query: search()! } : filterOf(entry()),
  );
  const msgs = createMemo(() => {
    version();
    return store.list(activeFilter(), limit());
  });
  const safeMsgIdx = createMemo(() => Math.max(0, Math.min(msgIdx(), msgs().length - 1)));
  const current = createMemo<MessageRow | undefined>(() => msgs()[safeMsgIdx()]);
  const opened = createMemo(() => {
    version();
    const c = current();
    return mode() === "reading" && c ? store.full(c.id) : null;
  });

  // OpenTUI only auto-paints after an input event. State that changes
  // out-of-band — async backend results (archive/trash/move via doBackend), the
  // 10s auto-refresh, on-demand body fetches — marks the scene dirty but would
  // otherwise not repaint until the next keypress. Track those signals and
  // request a frame explicitly. (Sync, in-handler updates already repaint; the
  // extra request there is a coalesced no-op.)
  createEffect(() => {
    version();
    status();
    busy();
    fetchTick();
    lastSync();
    renderer.requestRender();
  });

  // Auto-refresh the INBOX every 10s. Quiet: skips while a manual action is
  // running or a modal/search is open, never overlaps itself, and only bumps
  // the view (re-render) when the fetch actually changed something.
  onMount(() => {
    let inFlight = false;
    const id = setInterval(async () => {
      if (inFlight || busy() || typing() || picker() !== null || linkPicker() !== null || copy() !== null) return;
      inFlight = true;
      try {
        const r = await be.sync();
        if (r.ok) setLastSync(Date.now());
        // out looks like "fetched N, filed M by rules" — only redraw on change.
        const nums = r.out.match(/\d+/g)?.map(Number) ?? [];
        if (r.ok && nums.some((n) => n > 0)) {
          setVersion((v) => v + 1);
          setStatus(r.out);
        }
      } catch {
        /* transient IMAP error — next tick retries */
      } finally {
        inFlight = false;
      }
    }, 10_000);
    onCleanup(() => clearInterval(id));
  });

  // Reading body. Older mail keeps only metadata, so its body is fetched from
  // the server on demand when opened and cached in-session (bodyCache).
  // renderCache holds the lynx-rendered text per email+width so scrolling is
  // instant and lynx runs once. Both are plain Maps — the component body runs
  // once under Solid, so they persist without a ref wrapper.
  const renderCache = new Map<string, RenderedEmail>();
  const bodyCache = new Map<number, { body: string; html: string }>();
  const [fetchTick, setFetchTick] = createSignal(0);

  createEffect(() => {
    const o = opened();
    if (mode() !== "reading" || !o) return;
    if (o.body.trim() || o.html.trim() || bodyCache.has(o.id)) return;
    let cancelled = false;
    void be.body(o.id).then((r) => {
      if (cancelled) return;
      bodyCache.set(o.id, { body: r.body, html: r.html });
      setFetchTick((t) => t + 1);
    });
    onCleanup(() => {
      cancelled = true;
    });
  });

  const readingRendered = createMemo<RenderedEmail>(() => {
    const o = opened();
    if (!o) return { body: "", links: [], hiddenCount: 0 };
    fetchTick(); // re-run once the on-demand body arrives
    const c = bodyCache.get(o.id);
    const html = o.html.trim() ? o.html : (c?.html ?? "");
    const body = o.body.trim() ? o.body : (c?.body ?? "");
    if (!html.trim() && !body.trim()) return { body: c ? "" : "(fetching…)", links: [], hiddenCount: 0 };
    const key = `${o.id}:${listW()}`;
    if (!renderCache.has(key)) renderCache.set(key, renderEmail(html, body, listW()));
    return renderCache.get(key)!;
  });
  const readingBody = createMemo(() => {
    const r = readingRendered();
    if (!r.links.length && !r.hiddenCount) return r.body;
    const summary =
      `  ${r.links.length} numbered link${r.links.length === 1 ? "" : "s"}` +
      (r.hiddenCount ? ` · ${r.hiddenCount} hidden link${r.hiddenCount === 1 ? "" : "s"} omitted` : "");
    return `${r.body.replace(/\s+$/, "")}\n\nReferences\n${summary}${r.links.length ? " · o to open" : ""}`;
  });
  // Reader lines (headers + rendered body), unclipped and unfitted: the reading
  // pane displays a window of these, and copy mode selects over the same array
  // so what you copy is exactly what you see (minus the width truncation).
  const readerLines = createMemo<string[]>(() => {
    const o = opened();
    if (!o) return [];
    const atts: { name: string; type: string; size: number }[] = o.attachments ? JSON.parse(o.attachments) : [];
    const toAddr = cfg.accounts.find((a) => a.name === o.account)?.imapUser ?? "";
    return [
      `Id:      ${o.id}`,
      `Mailbox: ${o.account}`,
      `From:    ${o.from_name} <${o.from_addr}>`,
      ...(toAddr ? [`To:      ${toAddr}`] : []),
      `Subject: ${oneLine(o.subject)}`,
      `Date:    ${new Date(o.date * 1000).toLocaleString("en-GB")}`,
      `Category: ${o.category || "Uncategorized"}${o.source ? `  [${o.source}]` : ""}`,
      ...(o.html.trim() ? ["HTML email — v browser"] : []),
      ...atts.map((a) => `📎 ${a.name}  ${a.type}  ${(a.size / 1024).toFixed(0)} KB`),
      "─".repeat(Math.max(10, listW())),
      "",
      ...readingBody().split("\n"),
    ];
  });

  // Link picker over the open email's [N] references (reading mode, `o`).
  const [linkPicker, setLinkPicker] = createSignal<{ idx: number; query: string } | null>(null);
  // Copy mode (`y`). `line === null` is the field-only flavour used from the
  // list, where there are no reader lines to point at. Otherwise line/col is a
  // character cursor into readerLines() and `anchor` (when set) is the other
  // end of an inclusive selection.
  type Pos = { line: number; col: number };
  const [copy, setCopy] = createSignal<{ line: number | null; col: number; anchor: Pos | null } | null>(null);
  // The reading pane's text node. OpenTUI renders selections itself (mouse drag
  // out of the box, and startSelection/updateSelection for the keyboard), so
  // this ref is how copy mode paints its cursor and range.
  let readerRef: { x: number; y: number } | undefined;
  createEffect(() => {
    opened(); // changed message or left reading mode → stale line/link state
    batch(() => {
      setLinkPicker(null);
      setCopy(null);
    });
    renderer.clearSelection();
  });

  // Furthest the reader can scroll: the last screenful of the email (headers,
  // body and the References tail). Without this the pane scrolls off into blank
  // space past the end of the message.
  const maxScroll = createMemo(() => Math.max(0, readerLines().length - bodyH()));
  // `d`/`u` jump half a pane, so a few lines of context survive the jump.
  const page = () => Math.max(1, Math.floor(bodyH() / 2));

  const lineAt = (i: number) => readerLines()[i] ?? "";
  const clampCol = (line: number, col: number) => Math.max(0, Math.min(col, Math.max(0, lineAt(line).length - 1)));

  // Push copy mode's cursor/range into OpenTUI's own selection so the terminal
  // shows it. With no anchor the range is the single cursor cell (a block
  // cursor); with one it spans anchor..cursor inclusive, hence the +1 on the
  // trailing end (the native focus cell is exclusive).
  function paintSelection(c: { line: number | null; col: number; anchor: Pos | null }) {
    if (c.line === null || !readerRef) return;
    const cursor: Pos = { line: c.line, col: c.col };
    const anchor = c.anchor ?? cursor;
    const forward = cursor.line > anchor.line || (cursor.line === anchor.line && cursor.col >= anchor.col);
    const from = forward ? anchor : cursor;
    const to = forward ? cursor : anchor;
    const x0 = readerRef.x + from.col;
    const y0 = readerRef.y + (from.line - scroll());
    const x1 = readerRef.x + to.col + 1; // inclusive → exclusive
    const y1 = readerRef.y + (to.line - scroll());
    renderer.startSelection(readerRef as never, x0, y0);
    renderer.updateSelection(readerRef as never, x1, y1, { finishDragging: true });
  }
  createEffect(() => {
    const c = copy();
    scroll(); // repaint the selection after a scroll moves the lines
    // Only pushes; never clears, so a mouse drag (which owns the native
    // selection directly) is not fought over by this effect.
    if (c) paintSelection(c);
  });

  const targets = (): number[] => {
    const s = selected();
    const c = current();
    return s.size > 0 ? [...s] : c ? [c.id] : [];
  };

  // Instant cursor set with viewport-follow. No throttle needed: fine-grained
  // reactivity means only the affected rows repaint, and follow() keeps the
  // window still while the cursor moves inside it.
  function moveTo(n: number) {
    // Heading into the last loaded row while the view is still capped at the
    // current limit → pull the next page in before clamping, so the cursor can
    // keep going. msgs().length < limit() means the whole view is already loaded.
    if (n >= msgs().length - 1 && msgs().length >= limit()) setLimit((l) => l + PAGE);
    const clamped = Math.max(0, Math.min(n, msgs().length - 1));
    setMsgIdx(clamped);
    setListTop((t) => follow(clamped, t, bodyH()));
  }
  function scrollList(delta: number, resetScroll = false) {
    if (resetScroll) setScroll(0);
    moveTo(safeMsgIdx() + delta);
  }
  function moveCat(dir: 1 | -1) {
    const next = nextSelectable(entries(), safeCatIdx(), dir);
    batch(() => {
      setSearch(null);
      setLimit(PAGE);
      setCatIdx(next);
      setSideTop((t) => follow(next, t, bodyH()));
      moveTo(0);
    });
  }

  // Jump the active view to sidebar entry `i` (the goto picker's selection).
  // Focuses the list so the target is immediately actionable.
  function gotoIndex(i: number) {
    if (i < 0) return;
    batch(() => {
      setSearch(null);
      setLimit(PAGE);
      setCatIdx(i);
      setSideTop((t) => follow(i, t, bodyH()));
      setFocus("list");
      moveTo(0);
    });
  }

  // Move the list cursor to the next/prev unread message (no wrap).
  function jumpUnread(dir: 1 | -1) {
    const m = msgs();
    setFocus("list");
    for (let i = safeMsgIdx() + dir; i >= 0 && i < m.length; i += dir) {
      if (!m[i]!.seen) {
        moveTo(i);
        return;
      }
    }
    setStatus("no more unread");
  }

  async function doBackend(label: string, fn: () => { ok: boolean; out: string } | Promise<{ ok: boolean; out: string }>) {
    if (busy()) return;
    setBusy(true);
    setStatus(label + "…");
    const r = await fn();
    batch(() => {
      setSelected(new Set<number>());
      setVersion((v) => v + 1);
      setStatus(r.ok ? r.out : `error: ${r.out.slice(0, 120)}`);
      setBusy(false);
    });
  }

  function openInBrowser() {
    const c = current();
    if (!c) return;
    const m = store.full(c.id);
    if (!m) return;
    const cache = bodyCache.get(c.id); // on-demand body for older mail
    const html = m.html.trim() ? m.html : (cache?.html ?? "");
    const body = m.body.trim() ? m.body : (cache?.body ?? "");
    const doc = html.trim()
      ? html
      : `<!doctype html><meta charset=utf-8><pre style="white-space:pre-wrap;font:14px/1.5 system-ui">${body
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")}</pre>`;
    const p = join(tmpdir(), "mox-preview.html");
    writeFileSync(p, doc);
    spawn("open", [p], { stdio: "ignore", detached: true }).unref();
    setStatus("Opened HTML in browser");
  }

  // ----- copy mode (`y`) -----
  function copyOut(text: string, label: string) {
    const r = copyToClipboard(tidyCopy(text));
    batch(() => {
      setCopy(null);
      setStatus(r.ok ? `copied ${label}` : `clipboard error: ${r.error.slice(0, 100)}`);
    });
    renderer.clearSelection();
  }

  // Label for free-form copies: short text is quoted back so the status line
  // confirms exactly what landed on the clipboard.
  function copiedLabel(text: string): string {
    const lines = text.split("\n").length;
    if (lines > 1) return `${lines} lines`;
    const one = text.trim();
    return one.length <= 32 ? `"${one}"` : `${one.length} chars`;
  }

  // Full rows for the copy targets, in the order they appear in the view
  // (byIds() returns only the sync columns, so read each message properly).
  const copyRows = () => targets().map((id) => store.full(id)).filter((m) => m !== null);

  // One-key field copies. They act on the multi-selection when there is one, so
  // `space`-marking a few rows then `yi` yields every id, one per line.
  function copyField(kind: "id" | "from" | "subject") {
    const rows = copyRows();
    if (!rows.length) return;
    const value = rows
      .map((r) => (kind === "id" ? String(r.id) : kind === "from" ? r.from_addr : oneLine(r.subject)))
      .join("\n");
    const label =
      rows.length > 1
        ? `${rows.length} ${kind === "id" ? "ids" : kind === "from" ? "addresses" : "subjects"}`
        : kind === "id"
          ? `id ${value}`
          : kind === "from"
            ? `address ${value}`
            : "subject";
    copyOut(value, label);
  }

  // `a`: everything. In the reader that's the open email as shown (headers +
  // body); from the list it's one tab-separated row per target.
  function copyAll() {
    if (mode() === "reading" && readerLines().length) {
      const lines = readerLines();
      copyOut(lines.join("\n") + "\n", `whole email (${lines.length} lines)`);
      return;
    }
    const rows = copyRows();
    if (!rows.length) return;
    const tsv = rows
      .map((r) => [r.id, r.from_addr, oneLine(r.subject), new Date(r.date * 1000).toISOString()].join("\t"))
      .join("\n");
    copyOut(tsv + "\n", rows.length > 1 ? `${rows.length} rows` : "row");
  }

  // Text between the anchor and the cursor, inclusive on both ends — the same
  // range paintSelection() highlights, computed from our own state so what is
  // copied always matches what is shown.
  function selectionText(c: { line: number | null; col: number; anchor: Pos | null }): string {
    if (c.line === null) return "";
    const cursor: Pos = { line: c.line, col: c.col };
    const anchor = c.anchor ?? cursor;
    const forward = cursor.line > anchor.line || (cursor.line === anchor.line && cursor.col >= anchor.col);
    const from = forward ? anchor : cursor;
    const to = forward ? cursor : anchor;
    if (from.line === to.line) return lineAt(from.line).slice(from.col, to.col + 1);
    const out = [lineAt(from.line).slice(from.col)];
    for (let i = from.line + 1; i < to.line; i++) out.push(lineAt(i));
    out.push(lineAt(to.line).slice(0, to.col + 1));
    return out.join("\n");
  }

  // `y`: the selection when one is open, otherwise the cursor's whole line.
  function copySelection() {
    const c = copy();
    if (!c || c.line === null) return;
    if (!c.anchor) {
      const line = lineAt(c.line);
      copyOut(line + "\n", copiedLabel(line));
      return;
    }
    const text = selectionText(c);
    if (!text) {
      setStatus("nothing selected");
      return;
    }
    copyOut(text, copiedLabel(text));
  }

  // Cursor motions. `to` is a target position; the line is clamped to the email
  // and the column to that line, and the pane scrolls to keep the cursor shown.
  function moveCursor(to: Pos) {
    const c = copy();
    if (!c || c.line === null) return;
    const line = Math.max(0, Math.min(to.line, Math.max(0, readerLines().length - 1)));
    const col = clampCol(line, to.col);
    batch(() => {
      setCopy({ ...c, line, col });
      setScroll((top) => follow(line, top, bodyH()));
    });
  }


  function markDone(ids: number[], done: boolean, msg: string) {
    store.setDone(ids, done);
    batch(() => {
      setSelected(new Set<number>());
      setVersion((v) => v + 1);
      setStatus(msg);
    });
  }

  useKeyboard((e) => {
    const ch = e.sequence; // actual character (respects shift): "j", "M", "/"…
    const name = e.name; // logical key: "up", "return", "escape", "backspace"…

    if (typing()) {
      if (name === "escape") {
        batch(() => {
          setTyping(false);
          setDraft("");
        });
      } else if (name === "return" || name === "enter") {
        const d = draft().trim();
        batch(() => {
          setTyping(false);
          setLimit(PAGE);
          setSearch(d ? d : null);
          setSearchAt(Date.now());
          setFocus("list");
          moveTo(0);
        });
      } else if (name === "backspace" || name === "delete") {
        setDraft((d) => d.slice(0, -1));
      } else if (ch && ch.length === 1 && ch >= " " && !e.ctrl && !e.meta) {
        setDraft((d) => d + ch);
      }
      return;
    }

    if (picker()) {
      const p = picker()!;
      const filtered = filterOpts(p.options, p.query);
      // Type-to-filter: arrows navigate, printable chars edit the query (so j/k
      // are query text here, not navigation), enter picks, esc cancels.
      if (name === "escape") setPicker(null);
      else if (p.kind === "goto" && ch === "g" && p.query === "") {
        // `gg`: g opened this goto picker, a second g (before typing) = vim-style
        // jump to the top of the current list.
        batch(() => {
          setPicker(null);
          setFocus("list");
          moveTo(0);
        });
      } else if (name === "down") setPicker({ ...p, idx: Math.min(p.idx + 1, Math.max(0, filtered.length - 1)) });
      else if (name === "up") setPicker({ ...p, idx: Math.max(p.idx - 1, 0) });
      else if (name === "return" || name === "enter") {
        const choice = filtered[p.idx];
        if (!choice) return;
        setPicker(null);
        if (p.kind === "goto") {
          gotoIndex(entries().findIndex((e) => e.kind !== "header" && e.label === choice));
        } else {
          const ids = targets();
          void doBackend(`Moving ${ids.length} to ${choice}`, () => be.move(ids, choice));
        }
      } else if (name === "backspace" || name === "delete") {
        setPicker({ ...p, query: p.query.slice(0, -1), idx: 0 });
      } else if (ch && ch.length === 1 && ch >= " " && !e.ctrl && !e.meta) {
        setPicker({ ...p, query: p.query + ch, idx: 0 });
      }
      return;
    }

    if (copy()) {
      const c = copy()!;
      const at: Pos = { line: c.line ?? 0, col: c.col };
      if (name === "escape" || ch === "q") {
        setCopy(null);
        renderer.clearSelection();
      } else if (ch === "j" || name === "down") moveCursor({ ...at, line: at.line + 1 });
      else if (ch === "k" || name === "up") moveCursor({ ...at, line: at.line - 1 });
      else if (ch === "l" || name === "right") moveCursor({ ...at, col: at.col + 1 });
      else if (ch === "h" || name === "left") moveCursor({ ...at, col: at.col - 1 });
      else if (ch === "0") moveCursor({ ...at, col: 0 });
      else if (ch === "$") moveCursor({ ...at, col: Number.MAX_SAFE_INTEGER });
      else if (ch === "g") moveCursor({ line: 0, col: 0 });
      else if (ch === "G") moveCursor({ line: readerLines().length - 1, col: 0 });
      else if (ch === "v" && c.line !== null) setCopy({ ...c, anchor: c.anchor ? null : { ...at } });
      else if (ch === "y" || name === "return" || name === "enter") {
        if (c.line !== null) copySelection();
        else copyAll();
      } else if (ch === "i") copyField("id");
      else if (ch === "f") copyField("from");
      else if (ch === "s") copyField("subject");
      else if (ch === "a") copyAll();
      return;
    }

    if (linkPicker()) {
      const p = linkPicker()!;
      const filtered = filterLinks(readingRendered().links, p.query);
      if (name === "escape") setLinkPicker(null);
      else if (name === "down") setLinkPicker({ ...p, idx: Math.min(p.idx + 1, Math.max(0, filtered.length - 1)) });
      else if (name === "up") setLinkPicker({ ...p, idx: Math.max(0, p.idx - 1) });
      else if (name === "return" || name === "enter") {
        const link = filtered[p.idx];
        if (link) {
          spawn("open", [link.url], { stdio: "ignore", detached: true }).unref();
          setLinkPicker(null);
          setStatus(`Opened [${link.number}] ${link.host}`);
        }
      } else if (name === "backspace" || name === "delete") {
        setLinkPicker({ idx: 0, query: p.query.slice(0, -1) });
      } else if (ch && ch.length === 1 && ch >= " " && !e.ctrl && !e.meta) {
        setLinkPicker({ idx: 0, query: p.query + ch });
      }
      return;
    }

    if (mode() === "reading") {
      const c = current();
      if (name === "escape" || ch === "q" || name === "backspace") {
        batch(() => {
          setMode("list");
          setScroll(0);
        });
      } else if (ch === "j" || name === "down") {
        setScroll((s) => Math.min(s + 1, maxScroll())); // scroll the email, not to the next one
      } else if (ch === "k" || name === "up") {
        setScroll((s) => Math.max(0, s - 1));
      } else if (ch === "d") setScroll((s) => Math.min(s + page(), maxScroll())); // half-page down
      else if (ch === "u") setScroll((s) => Math.max(0, s - page())); // half-page up
      else if (ch === "g") setScroll(0); // top of the email
      else if (ch === "G") setScroll(maxScroll()); // bottom of the email
      else if (ch === "l" || name === "right") scrollList(1, true); // next email
      else if (ch === "h" || name === "left") scrollList(-1, true); // previous email
      else if (ch === "v") openInBrowser();
      else if (ch === "o") {
        if (readingRendered().links.length) setLinkPicker({ idx: 0, query: "" });
        else setStatus("no links in this email");
      } else if (ch === "y") {
        setCopy({ line: scroll(), col: 0, anchor: null }); // first visible line
      } else if (ch === "s") {
        if (c) void doBackend("Downloading attachments", () => be.download(c.id));
      } else if (ch === "e") {
        setScroll(0);
        setMode("list");
        markDone(targets(), true, `done ${targets().length}`);
      } else if (ch === "a") {
        batch(() => { setMode("list"); setScroll(0); });
        void doBackend("Archiving on server", () => be.archive(targets()));
      } else if (ch === "t") {
        batch(() => { setMode("list"); setScroll(0); });
        void doBackend("Trashing on server", () => be.trash(targets()));
      } else if (ch === "z") {
        if (c?.mailbox === "Trash") {
          batch(() => { setMode("list"); setScroll(0); });
          void doBackend("Restoring from Trash", () => be.untrash(targets()));
        } else if (c?.mailbox === "Archive") {
          batch(() => { setMode("list"); setScroll(0); });
          void doBackend("Unarchiving", () => be.unarchive(targets()));
        } else if (c?.done) {
          setScroll(0);
          setMode("list");
          markDone(targets(), false, `restored ${targets().length} to inbox`);
        }
      } else if (ch === "M") void doBackend("Marking read on server", () => be.mark(targets(), true));
      else if (ch === "U") void doBackend("Marking unread on server", () => be.mark(targets(), false));
      return;
    }

    // `g` opens a type-to-filter picker over every view (Inbox, ALL, accounts,
    // filters, folders) — pick one to jump the active view there.
    if (ch === "g") {
      const opts = entries().filter((e) => e.kind !== "header").map((e) => e.label);
      if (opts.length > 0) setPicker({ kind: "goto", options: opts, idx: 0, query: "" });
      return;
    }

    if (ch === "q") exit();
    else if (ch === "G") {
      batch(() => {
        setLimit(Number.MAX_SAFE_INTEGER); // load the whole view, then jump to the true bottom
        setFocus("list");
        moveTo(msgs().length - 1);
      });
    } else if (ch === "n") jumpUnread(1);
    else if (ch === "p") jumpUnread(-1);
    else if (ch === "/") {
      batch(() => {
        setTyping(true);
        setDraft(search() ?? "");
      });
    } else if (name === "escape" && search() !== null) {
      batch(() => {
        setSearch(null); // clear search, back to sidebar filter
        setLimit(PAGE);
        moveTo(0);
      });
    } else if ((name === "return" || name === "enter") && current()) setMode("reading");
    else if (name === "tab" || ch === "h" || ch === "l" || name === "left" || name === "right")
      setFocus(focus() === "sidebar" ? "list" : "sidebar");
    else if (ch === "j" || name === "down") {
      if (focus() === "sidebar") moveCat(1);
      else scrollList(1);
    } else if (ch === "k" || name === "up") {
      if (focus() === "sidebar") moveCat(-1);
      else scrollList(-1);
    } else if (ch === "d") {
      // Half-page through whichever pane has focus.
      if (focus() === "sidebar") for (let i = 0; i < page(); i++) moveCat(1);
      else moveTo(safeMsgIdx() + page());
    } else if (ch === "u") {
      if (focus() === "sidebar") for (let i = 0; i < page(); i++) moveCat(-1);
      else moveTo(safeMsgIdx() - page());
    } else if (name === "space" && current()) {
      const c = current()!;
      const next = new Set(selected());
      next.has(c.id) ? next.delete(c.id) : next.add(c.id);
      setSelected(next);
      moveTo(safeMsgIdx() + 1);
    } else if (name === "escape") setSelected(new Set<number>());
    else if (ch === "r")
      void doBackend("Fetching new mail", async () => {
        const r = await be.sync();
        if (r.ok) setLastSync(Date.now());
        return r;
      });
    else if (ch === "M") void doBackend("Marking read on server", () => be.mark(targets(), true));
    else if (ch === "U") void doBackend("Marking unread on server", () => be.mark(targets(), false));
    else if (ch === "s" && current()) void doBackend("Downloading attachments", () => be.download(current()!.id));
    else if (ch === "e" && targets().length > 0) markDone(targets(), true, `done ${targets().length}`);
    else if (ch === "a" && targets().length > 0) void doBackend("Archiving on server", () => be.archive(targets()));
    else if (ch === "t" && targets().length > 0) void doBackend("Trashing on server", () => be.trash(targets()));
    else if (ch === "z" && targets().length > 0) {
      // Restore: opposite of trash/archive/done depending on where the mail is.
      const c = current();
      if (c?.mailbox === "Trash") void doBackend("Restoring from Trash", () => be.untrash(targets()));
      else if (c?.mailbox === "Archive") void doBackend("Unarchiving", () => be.unarchive(targets()));
      else if (c?.done) markDone(targets(), false, `restored ${targets().length} to inbox`);
    } else if (ch === "m" && targets().length > 0) {
      const cats = [...new Set([...cfg.categories.map((c) => c.name), ...store.approvedCategories()])];
      if (cats.length > 0) setPicker({ kind: "move", options: cats, idx: 0, query: "" });
    } else if (ch === "v") openInBrowser();
    else if (ch === "y" && current()) setCopy({ line: null, col: 0, anchor: null }); // field copies only
  });

  // ----- derived render data -----
  const nowYear = new Date().getFullYear();
  const senderW = 18;
  const catW = createMemo(() => (listW() < 72 ? 0 : 13));
  const dateW = 17; // "Jul 20 2024 15:04" (year shown only for non-current-year)
  // Leading cluster is sel+done+read (3) + the 2-cell attachment column + a space.
  const subjW = createMemo(() =>
    Math.max(0, listW() - (3 + 2 + 1 + senderW + 1 + (catW() > 0 ? catW() + 1 : 0) + dateW + 1)),
  );

  const visible = createMemo(() => {
    const m = msgs();
    const top = Math.max(0, Math.min(listTop(), Math.max(0, m.length - bodyH())));
    return { top, rows: m.slice(top, top + bodyH()) };
  });
  const sideVisible = createMemo(() => {
    const es = entries();
    const top = Math.max(0, Math.min(sideTop(), Math.max(0, es.length - bodyH())));
    return { top, rows: es.slice(top, top + bodyH()) };
  });

  // Mouse: per-pane wheel scroll + per-row click. Local handlers avoid all the
  // absolute-coordinate math the old ANSI mouse parser needed.
  const onSidebarScroll = (ev: MouseEvent) => {
    if (picker() || linkPicker() || copy() || typing()) return;
    moveCat(ev.scroll?.direction === "up" ? -1 : 1);
  };
  // Mouse text selection in the reader. OpenTUI does the selecting and the
  // highlighting; we only note where the press landed and, on release, copy
  // whatever got selected — drag over a few words and they are on the
  // clipboard, no mode to enter. A plain click (no movement) just clears.
  let pressAt: { x: number; y: number } | null = null;
  const onReaderMouseDown = (ev: MouseEvent) => {
    if (mode() !== "reading" || picker() || linkPicker() || typing()) return;
    pressAt = { x: ev.x, y: ev.y };
    setCopy(null); // hand the selection over to the mouse (no clear: it owns it now)
  };
  const onReaderMouseUp = (ev: MouseEvent) => {
    if (mode() !== "reading" || !pressAt) return;
    const moved = ev.x !== pressAt.x || ev.y !== pressAt.y;
    pressAt = null;
    if (!moved) return;
    const text = renderer.getSelection()?.getSelectedText() ?? "";
    if (!text.trim()) return;
    copyOut(text, copiedLabel(text));
  };

  const onListScroll = (ev: MouseEvent) => {
    if (picker() || linkPicker() || copy() || typing()) return;
    if (mode() === "reading") {
      setScroll((s) => Math.max(0, Math.min(s + (ev.scroll?.direction === "up" ? -3 : 3), maxScroll())));
    } else scrollList(ev.scroll?.direction === "up" ? -3 : 3);
  };

  // Available actions for the current selection. In Trash/Archive only restore
  // applies; a done email can be restored to the inbox AND still archived,
  // trashed or moved; an undone email can be marked done. (a/d/m keybinds are
  // never gated by this — it only drives the hint text.)
  const inTrashOrArchive = createMemo(() => {
    const f = activeFilter();
    return f.kind === "folder" && (f.class === "Trash" || f.class === "Archive");
  });
  const actionHint = createMemo(() =>
    inTrashOrArchive()
      ? "z restore"
      : current()?.done
        ? "z restore · a archive · t trash"
        : "e done · a archive · t trash",
  );
  const hasAtts = createMemo(() => {
    const o = opened();
    return !!o?.attachments && o.attachments !== "" && o.attachments !== "[]";
  });
  const hint = createMemo(() => {
    const c = copy();
    if (c) {
      // Kept under 80 cells so the whole hint survives on a narrow terminal.
      if (c.line === null) return `COPY · i id · f from · s subj · a row · esc`;
      return c.anchor
        ? `COPY · hjkl extend · SELECTING · y copy · esc cancel`
        : `COPY · hjkl move · v select · y line · i/f/s/a fields · esc`;
    }
    return mode() === "reading"
      ? `j/k scroll · d/u page · g/G ends · h/l prev/next · v html${readingRendered().links.length ? " · o links" : ""} · y copy${hasAtts() ? " · s save files" : ""} · ${actionHint()} · M/U read · esc/q back`
      : `enter open · ${actionHint()} · d/u page · m move · g goto · y copy · n/p unread · / search · r refresh · q quit${selected().size > 0 ? ` · ${selected().size} selected` : ""}`;
  });

  const headerNote = createMemo(() =>
    typing()
      ? `  /${draft()}▏` + (draft() === "" ? "  from: subj: body: is:unread has:attachment in:sent" : "")
      : search() !== null
        ? // Keep action feedback visible in search mode: a status produced after
          // the search was committed (download/archive/…) replaces "esc clear".
          `  search: "${search()}" (${msgs().length}) · ${statusAt() > searchAt() ? status() : "esc clear"}`
        : "  " + status(),
  );
  const synced = createMemo(() =>
    lastSync()
      ? "synced " + new Date(lastSync()).toLocaleTimeString("en-GB", { hour12: false })
      : "not synced yet",
  );

  return (
    <box flexDirection="column" width={dims().width} height={dims().height}>
      {/* header */}
      <box flexDirection="row">
        <text fg={PINK} attributes={TextAttributes.BOLD}>mox</text>
        <text fg={typing() ? BLUE : DIM}>
          {fit(headerNote(), Math.max(0, dims().width - 3 - synced().length - 1))}
        </text>
        <text fg={DIM}>{synced()}</text>
      </box>

      <box flexDirection="row">
        {/* sidebar */}
        <box
          width={SIDEBAR_W + 2}
          height={bodyH() + 2}
          border
          borderStyle="rounded"
          borderColor={focus() === "sidebar" && mode() === "list" ? PINK : GRAY}
          flexDirection="column"
          overflow="hidden"
          onMouseScroll={onSidebarScroll}
        >
          <For each={sideVisible().rows}>
            {(e, i) => {
              const abs = () => sideVisible().top + i();
              return (
                <Show
                  when={e.kind !== "header"}
                  fallback={<text fg={BLUE} attributes={TextAttributes.BOLD}>{fit(`── ${e.label} `, SIDEBAR_W)}</text>}
                >
                  <text
                    selectable={false}
                    bg={abs() === safeCatIdx() ? PINK : undefined}
                    fg={abs() === safeCatIdx() ? BLACK : undefined}
                    onMouseDown={() => {
                      batch(() => {
                        setSearch(null);
                        setFocus("sidebar");
                        setCatIdx(abs());
                        moveTo(0);
                      });
                    }}
                  >
                    {fit(e.label, SIDEBAR_W)}
                  </text>
                </Show>
              );
            }}
          </For>
        </box>

        {/* right pane */}
        <box
          width={listW() + 2}
          height={bodyH() + 2}
          border
          borderStyle="rounded"
          borderColor={mode() === "reading" || focus() === "list" ? PINK : GRAY}
          flexDirection="column"
          overflow="hidden"
          onMouseScroll={onListScroll}
          onMouseDown={onReaderMouseDown}
          onMouseUp={onReaderMouseUp}
        >
          <Show
            when={mode() === "reading" && opened()}
            fallback={
              <Show
                when={msgs().length > 0}
                fallback={<text fg={DIM}>{search() !== null ? `no matches for "${search()}"` : "(empty)"}</text>}
              >
                <For each={visible().rows}>
                  {(m, i) => {
                    const abs = () => visible().top + i();
                    const cursor = () => abs() === safeMsgIdx();
                    const selCh = () => (selected().has(m.id) ? "●" : " ");
                    const doneCh = m.done ? "✓" : " ";
                    const readCh = m.seen ? " " : "•";
                    // Fixed 2-cell attachment column: the clip (width 2) or two
                    // spaces, so rows stay aligned whether or not there's a file.
                    const clip = m.has_att ? oneLine("📎") : "  ";
                    const sender = fit(oneLine(m.from_name || m.from_addr), senderW);
                    const d = new Date(m.date * 1000);
                    const dm = d.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
                    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
                    const date = fit(
                      d.getFullYear() === nowYear ? `${dm} ${time}` : `${dm} ${d.getFullYear()} ${time}`,
                      dateW,
                    );
                    const cat = () => (catW() > 0 ? fit(m.category || "—", catW()) : "");
                    const subj = () => fit(oneLine(m.subject) || "(no subject)", subjW());
                    const onDown = () => {
                      setFocus("list");
                      if (abs() === safeMsgIdx()) setMode("reading"); // click current row = open
                      else moveTo(abs());
                    };
                    return (
                      <Show
                        when={!cursor()}
                        fallback={
                          <text selectable={false} bg={PINK} fg={BLACK} onMouseDown={onDown}>
                            {fit(
                              `${selCh()}${doneCh}${readCh}${clip} ${sender} ${cat()}${catW() > 0 ? " " : ""}${subj()} ${date}`,
                              listW(),
                            )}
                          </text>
                        }
                      >
                        {/* One <text> row with colored <span> segments; the scene
                            graph repaints only the row whose signal changed, so held
                            j/k stays smooth. */}
                        <text selectable={false} attributes={m.seen ? undefined : TextAttributes.BOLD} onMouseDown={onDown}>
                          <Seg fg={PINK} text={selCh()} />
                          <Seg fg={DONE} text={doneCh} />
                          <Seg text={`${readCh}${clip} ${sender} `} />
                          <Show when={catW() > 0}>
                            <Seg fg={CAT} text={`${cat()} `} />
                          </Show>
                          <Seg text={`${subj()} `} />
                          <Seg fg={DIM} text={date} />
                        </text>
                      </Show>
                    );
                  }}
                </For>
              </Show>
            }
          >
            <Reading
              lines={readerLines()}
              scroll={scroll()}
              w={listW()}
              h={bodyH()}
              ref={(el) => (readerRef = el)}
            />
          </Show>
        </box>
      </box>

      <text fg={DIM}>{fit(hint(), dims().width)}</text>

      <Show when={picker()}>
        {(p) => {
          // Filter by the typed query, then window so a long list fits on
          // screen, clamping the box position so it never renders off the top.
          const filtered = () => filterOpts(p().options, p().query);
          const maxRows = () => Math.max(1, Math.min(filtered().length, dims().height - 7));
          const w = 30;
          const start = () => Math.max(0, Math.min(p().idx - Math.floor(maxRows() / 2), filtered().length - maxRows()));
          const shown = () => filtered().slice(start(), start() + maxRows());
          const boxH = () => maxRows() + 5;
          return (
            <box
              position="absolute"
              left={Math.max(1, Math.floor((dims().width - w) / 2) - 3)}
              top={Math.max(1, Math.floor((dims().height - boxH()) / 2))}
              zIndex={10}
              border
              borderStyle="rounded"
              borderColor={PINK}
              backgroundColor={BLACK}
              flexDirection="column"
              paddingLeft={2}
              paddingRight={2}
            >
              <text fg={PINK} attributes={TextAttributes.BOLD}>
                {p().kind === "goto" ? "Go to view:" : `Move (${targets().length} email(s)):`}
              </text>
              <text fg={p().query ? BLUE : DIM}>{fit(`/${p().query}▏`, w)}</text>
              <Show when={filtered().length > 0} fallback={<text fg={DIM}>{fit("no match", w)}</text>}>
                <For each={shown()}>
                  {(o, i) => {
                    const abs = () => start() + i();
                    return (
                      <text bg={abs() === p().idx ? PINK : undefined} fg={abs() === p().idx ? BLACK : undefined}>
                        {fit((abs() === p().idx ? "> " : "  ") + o, w)}
                      </text>
                    );
                  }}
                </For>
              </Show>
              <text fg={DIM}>type filter · ↑/↓ move · enter · esc</text>
            </box>
          );
        }}
      </Show>

      <Show when={linkPicker()}>
        {(p) => (
          <LinkPicker
            state={p()}
            links={filterLinks(readingRendered().links, p().query)}
            total={readingRendered().links.length}
            width={dims().width}
            height={dims().height}
          />
        )}
      </Show>
    </box>
  );
}

// Inline colored text segment. Inline text nodes only honor `href`/`style` in
// the Solid reconciler, so color goes through `style.fg` (typed loosely there).
function Seg(props: { fg?: string; text: string }) {
  return <span style={{ fg: props.fg } as any}>{props.text}</span>;
}

// Filterable overlay over the open email's [N] link references: type a number
// or text to narrow, enter opens the link in the browser.
function LinkPicker(props: {
  state: { idx: number; query: string };
  links: LinkRef[];
  total: number;
  width: number;
  height: number;
}) {
  const width = () => Math.max(30, Math.min(92, props.width - 8));
  const maxItems = () => Math.max(1, Math.min(props.links.length, props.height - 10));
  const start = () => Math.max(0, Math.min(props.state.idx - Math.floor(maxItems() / 2), props.links.length - maxItems()));
  const shown = () => props.links.slice(start(), start() + maxItems());

  return (
    <box
      position="absolute"
      left={Math.max(1, Math.floor((props.width - width()) / 2) - 3)}
      top={Math.max(1, Math.floor((props.height - maxItems() - 8) / 2))}
      zIndex={10}
      border
      borderStyle="rounded"
      borderColor={PINK}
      backgroundColor={BLACK}
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
    >
      <text fg={PINK} attributes={TextAttributes.BOLD}>{`Open numbered link (${props.total})`}</text>
      <text fg={props.state.query ? BLUE : DIM}>{fit(`/${props.state.query}▏  reference number, label, or domain`, width())}</text>
      <Show when={props.links.length} fallback={<text fg={DIM}>{fit("no match", width())}</text>}>
        <For each={shown()}>
          {(link, index) => {
            const absolute = () => start() + index();
            const active = () => absolute() === props.state.idx;
            return (
              <text bg={active() ? PINK : undefined} fg={active() ? BLACK : undefined}>
                {fit(`${active() ? ">" : " "} [${link.number}] ${link.url.replace(/^https?:\/\//i, "")}${link.tracking ? " [tracking]" : ""}`, width())}
              </text>
            );
          }}
        </For>
      </Show>
      <text fg={DIM}>type number/text · ↑/↓ move · enter open in browser · esc</text>
    </box>
  );
}

function Reading(props: {
  lines: string[]; // headers + body, unclipped (built by the App so copy mode shares it)
  scroll: number;
  w: number;
  h: number;
  ref: (el: { x: number; y: number }) => void;
}) {
  const rows = createMemo(() => props.lines.slice(props.scroll, props.scroll + props.h).map((l) => fit(oneLine(l), props.w)));
  // ONE <text> for the whole pane (joined by \n): scrolling repaints a single
  // node, and it is also the selection surface — OpenTUI selects and highlights
  // across it for both mouse drags and copy mode's cursor.
  return (
    <text ref={props.ref} selectable selectionBg={PINK} selectionFg={BLACK}>
      {rows().join("\n") || " "}
    </text>
  );
}
