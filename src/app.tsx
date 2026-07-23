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
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store, FOLDER_CLASSES, type Filter, type MessageRow } from "./db.ts";
import { loadConfig, type Config } from "./config.ts";
import { backend } from "./backend.ts";
import { warmConnections } from "./mail.ts";
import { fit, oneLine } from "./text.ts";

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

// Render an email to display text: lynx flows the HTML (layout tables → text,
// links as [N] refs); plain-text body otherwise. Runs once per open (cached).
function renderEmailBody(html: string, body: string, width: number): string {
  if (html.trim()) {
    const l = spawnSync(
      "lynx",
      ["-dump", "-force_html", "-nomargins", `-width=${Math.max(40, width)}`, "-assume_charset=utf-8", "-display_charset=utf-8", "-stdin"],
      { input: html, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (l.status === 0 && l.stdout.trim()) return l.stdout;
    if (!body.trim()) return html.replace(/<[^>]+>/g, " ").replace(/\s+\n/g, "\n");
  }
  return body;
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
  const [status, setStatus] = createSignal("Press r to fetch new mail");
  const [busy, setBusy] = createSignal(false);
  const [scroll, setScroll] = createSignal(0);
  const [picker, setPicker] = createSignal<{ kind: "move" | "goto"; options: string[]; idx: number; query: string } | null>(null);
  const [search, setSearch] = createSignal<string | null>(null); // committed query
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
      if (inFlight || busy() || typing() || picker() !== null) return;
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
  const renderCache = new Map<string, string>();
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

  const readingBody = createMemo(() => {
    const o = opened();
    if (!o) return "";
    fetchTick(); // re-run once the on-demand body arrives
    const c = bodyCache.get(o.id);
    const html = o.html.trim() ? o.html : (c?.html ?? "");
    const body = o.body.trim() ? o.body : (c?.body ?? "");
    if (!html.trim() && !body.trim()) return c ? "" : "(fetching…)";
    const key = `${o.id}:${listW()}`;
    if (!renderCache.has(key)) renderCache.set(key, renderEmailBody(html, body, listW()));
    return renderCache.get(key)!;
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

    if (mode() === "reading") {
      const c = current();
      if (name === "escape" || ch === "q" || name === "backspace") {
        batch(() => {
          setMode("list");
          setScroll(0);
        });
      } else if (ch === "j" || name === "down") {
        setScroll((s) => s + 1); // scroll the open email, not next/prev message
      } else if (ch === "k" || name === "up") {
        setScroll((s) => Math.max(0, s - 1));
      } else if (ch === "l" || name === "right") scrollList(1, true); // next email
      else if (ch === "h" || name === "left") scrollList(-1, true); // previous email
      else if (ch === "v") openInBrowser();
      else if (ch === "s") {
        if (c) void doBackend("Downloading attachments", () => be.download(c.id));
      } else if (ch === "e") {
        setScroll(0);
        setMode("list");
        markDone(targets(), true, `done ${targets().length}`);
      } else if (ch === "a") {
        batch(() => { setMode("list"); setScroll(0); });
        void doBackend("Archiving on server", () => be.archive(targets()));
      } else if (ch === "d") {
        batch(() => { setMode("list"); setScroll(0); });
        void doBackend("Trashing on server", () => be.trash(targets()));
      } else if (ch === "u") {
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
    else if (ch === "d" && targets().length > 0) void doBackend("Trashing on server", () => be.trash(targets()));
    else if (ch === "u" && targets().length > 0) {
      // Restore: opposite of trash/archive/done depending on where the mail is.
      const c = current();
      if (c?.mailbox === "Trash") void doBackend("Restoring from Trash", () => be.untrash(targets()));
      else if (c?.mailbox === "Archive") void doBackend("Unarchiving", () => be.unarchive(targets()));
      else if (c?.done) markDone(targets(), false, `restored ${targets().length} to inbox`);
    } else if (ch === "m" && targets().length > 0) {
      const cats = [...new Set([...cfg.categories.map((c) => c.name), ...store.approvedCategories()])];
      if (cats.length > 0) setPicker({ kind: "move", options: cats, idx: 0, query: "" });
    } else if (ch === "v") openInBrowser();
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
    if (picker() || typing()) return;
    moveCat(ev.scroll?.direction === "up" ? -1 : 1);
  };
  const onListScroll = (ev: MouseEvent) => {
    if (picker() || typing()) return;
    if (mode() === "reading") {
      setScroll((s) => Math.max(0, s + (ev.scroll?.direction === "up" ? -3 : 3)));
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
      ? "u restore"
      : current()?.done
        ? "u restore · a archive · d trash"
        : "e done · a archive · d trash",
  );
  const hasAtts = createMemo(() => {
    const o = opened();
    return !!o?.attachments && o.attachments !== "" && o.attachments !== "[]";
  });
  const hint = createMemo(() =>
    mode() === "reading"
      ? `j/k scroll · h/l prev/next · v html${hasAtts() ? " · s save" : ""} · ${actionHint()} · M/U read · esc/q back`
      : `enter open · ${actionHint()} · m move · g goto · n/p unread · / search · r refresh · q quit${selected().size > 0 ? ` · ${selected().size} selected` : ""}`,
  );

  const headerNote = createMemo(() =>
    typing()
      ? `  /${draft()}▏` + (draft() === "" ? "  from: subj: body: is:unread has:attachment in:sent" : "")
      : search() !== null
        ? `  search: "${search()}" (${msgs().length}) · esc clear`
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
                          <text bg={PINK} fg={BLACK} onMouseDown={onDown}>
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
                        <text attributes={m.seen ? undefined : TextAttributes.BOLD} onMouseDown={onDown}>
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
              opened={opened()!}
              toAddr={cfg.accounts.find((a) => a.name === opened()!.account)?.imapUser ?? ""}
              body={readingBody()}
              scroll={scroll()}
              w={listW()}
              h={bodyH()}
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
    </box>
  );
}

// Inline colored text segment. Inline text nodes only honor `href`/`style` in
// the Solid reconciler, so color goes through `style.fg` (typed loosely there).
function Seg(props: { fg?: string; text: string }) {
  return <span style={{ fg: props.fg } as any}>{props.text}</span>;
}

function Reading(props: {
  opened: NonNullable<ReturnType<Store["full"]>>;
  toAddr: string;
  body: string;
  scroll: number;
  w: number;
  h: number;
}) {
  const lines = createMemo(() => {
    const o = props.opened;
    const atts: { name: string; type: string; size: number }[] = o.attachments ? JSON.parse(o.attachments) : [];
    const head = [
      `Mailbox: ${o.account}`,
      `From:    ${o.from_name} <${o.from_addr}>`,
      ...(props.toAddr ? [`To:      ${props.toAddr}`] : []),
      `Subject: ${oneLine(o.subject)}`,
      `Date:    ${new Date(o.date * 1000).toLocaleString("en-GB")}`,
      `Category: ${o.category || "Uncategorized"}${o.source ? `  [${o.source}]` : ""}`,
      ...(o.html.trim() ? ["HTML email — v browser"] : []),
      ...atts.map((a) => `📎 ${a.name}  ${a.type}  ${(a.size / 1024).toFixed(0)} KB`),
      "─".repeat(Math.max(10, props.w)),
      "",
    ];
    const body = (props.body || "").split("\n").map((l) => oneLine(l));
    return [...head, ...body].slice(props.scroll, props.scroll + props.h).map((l) => fit(l, props.w));
  });
  // One <text> for the whole pane (joined by \n) — the reading view is a single
  // node, so scrolling repaints just this text.
  return <text>{lines().join("\n") || " "}</text>;
}
