// spark-ink — Ink/React TUI over the Go spark-cli backend. Layout and
// keybindings mirror the Go TUI: sidebar (All / mailboxes / manual / other),
// message list, reading view. Reads sqlite directly; every write shells out to
// the Go binary. Filing is by sender rules only — no AI classification.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store, FOLDER_CLASSES, type Filter, type MessageRow } from "./db.ts";
import { loadConfig, categoryHasRules, type Config } from "./config.ts";
import { backend } from "./backend.ts";
import { warmConnections } from "./mail.ts";
import { fit, oneLine, isBot } from "./text.ts";
import { useMouse, isMouseSeq } from "./mouse.ts";

const SIDEBAR_W = 26;
const PINK = "#ff5faf";
const BLUE = "#00afff";
const DIM = "#808080";
const CAT = "#87afaf";
const HUMAN = "#87d787"; // sender-from-a-person marker

// Snooze durations offered in the picker (label → seconds from now).
const SNOOZE_OPTIONS: [string, number][] = [
  ["1 hour", 3600],
  ["3 hours", 10800],
  ["Tomorrow", 86400],
  ["3 days", 259200],
  ["Next week", 604800],
];

type SideEntry =
  | { kind: "inbox"; label: string; exclude: string[] }
  | { kind: "all"; label: string; exclude: string[] }
  | { kind: "header"; label: string }
  | { kind: "account"; name: string; label: string; exclude: string[] }
  | { kind: "category"; name: string; label: string }
  | { kind: "folder"; cls: string; label: string }
  | { kind: "snoozed"; label: string }
  | { kind: "done"; label: string };

function buildSidebar(store: Store, cfg: Config): SideEntry[] {
  const ex = cfg.inboxExclude;
  const accCounts = store.accountCounts(ex);
  const catCounts = store.categoryCounts();
  // Top-level views: INBOX (important, minus excluded categories) · DONE · ALL.
  // Excluded/muted categories are hidden from INBOX, ALL and account views —
  // reachable only via their own category entry.
  const entries: SideEntry[] = [
    { kind: "inbox", label: `INBOX (${store.inboxCount(ex)})`, exclude: ex },
    { kind: "done", label: `DONE (${store.doneCount()})` },
    { kind: "all", label: `ALL (${store.allCount(ex)})`, exclude: ex },
  ];

  const accounts = cfg.accounts.map((a) => a.name).filter((n) => (accCounts.get(n) ?? 0) > 0);
  if (accounts.length > 1) {
    entries.push({ kind: "header", label: "Mailboxes" });
    for (const a of accounts)
      entries.push({ kind: "account", name: a, label: `${a} (${accCounts.get(a)})`, exclude: ex });
  }

  const manual = cfg.categories.filter((c) => categoryHasRules(c) && (catCounts.get(c.name) ?? 0) > 0);
  if (manual.length > 0) {
    entries.push({ kind: "header", label: "Manual" });
    for (const c of manual)
      entries.push({ kind: "category", name: c.name, label: `${c.name} (${catCounts.get(c.name)})` });
  }

  const aiNames = new Set<string>();
  for (const c of cfg.categories) if (!categoryHasRules(c) && (catCounts.get(c.name) ?? 0) > 0) aiNames.add(c.name);
  for (const c of store.approvedCategories())
    if ((catCounts.get(c) ?? 0) > 0 && !manual.some((m) => m.name === c)) aiNames.add(c);
  const ai = [...aiNames];
  if ((catCounts.get("Suggested") ?? 0) > 0) ai.push("Suggested");
  if ((catCounts.get("Uncategorized") ?? 0) > 0) ai.push("Uncategorized");
  if (ai.length > 0) {
    entries.push({ kind: "header", label: "Other" });
    for (const name of ai)
      entries.push({ kind: "category", name, label: `${name} (${catCounts.get(name)})` });
  }

  const folderCounts = store.folderCounts();
  const folderRows = FOLDER_CLASSES.filter((c) => (folderCounts.get(c) ?? 0) > 0);
  if (folderRows.length > 0) {
    entries.push({ kind: "header", label: "Folders" });
    for (const c of folderRows)
      entries.push({ kind: "folder", cls: c, label: `${c} (${folderCounts.get(c)})` });
  }

  const snoozed = store.snoozedCount();
  if (snoozed > 0) {
    entries.push({ kind: "header", label: "Views" });
    entries.push({ kind: "snoozed", label: `Snoozed (${snoozed})` });
  }
  return entries;
}

function filterOf(e: SideEntry): Filter {
  if (e.kind === "inbox") return { kind: "inbox", exclude: e.exclude };
  if (e.kind === "account") return { kind: "account", name: e.name, exclude: e.exclude };
  if (e.kind === "category") return { kind: "category", name: e.name };
  if (e.kind === "folder") return { kind: "folder", class: e.cls };
  if (e.kind === "snoozed") return { kind: "snoozed" };
  if (e.kind === "done") return { kind: "done" };
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

function nextSelectable(entries: SideEntry[], idx: number, dir: 1 | -1): number {
  let i = idx + dir;
  while (i >= 0 && i < entries.length) {
    if (entries[i]!.kind !== "header") return i;
    i += dir;
  }
  return idx;
}

export function App({
  dbPath,
  cfgPath,
}: {
  dbPath: string;
  cfgPath: string;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const store = useMemo(() => new Store(dbPath), [dbPath]);
  const [cfg, setCfg] = useState<Config>(() => loadConfig(cfgPath));
  const be = useMemo(() => backend(store, cfg, cfgPath), [store, cfg, cfgPath]);

  const [size, setSize] = useState({ cols: stdout.columns, rows: stdout.rows });
  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);

  // Open IMAP connections in the background at startup so the first `r` refresh
  // doesn't pay the login cost.
  useEffect(() => void warmConnections(cfg.accounts), [cfg]);

  const [version, setVersion] = useState(0); // bump after writes to re-query
  const [catIdx, setCatIdx] = useState(0);
  const [msgIdx, setMsgIdx] = useState(0);
  const [focus, setFocus] = useState<"sidebar" | "list">("sidebar");
  const [mode, setMode] = useState<"list" | "reading">("list");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState("Press r to fetch new mail");
  const [busy, setBusy] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [picker, setPicker] = useState<{ kind: "move" | "snooze"; options: string[]; idx: number } | null>(null);
  const [search, setSearch] = useState<string | null>(null); // committed query
  const [typing, setTyping] = useState(false); // search input active
  const [draft, setDraft] = useState("");

  const entries = useMemo(() => buildSidebar(store, cfg), [store, cfg, version]);
  const safeCatIdx = Math.min(catIdx, entries.length - 1);
  const entry = entries[safeCatIdx]!.kind === "header" ? entries[0]! : entries[safeCatIdx]!;
  const activeFilter: Filter = search !== null ? { kind: "search", query: search } : filterOf(entry);
  const msgs = useMemo(() => store.list(activeFilter), [store, entry, version, search]);
  const safeMsgIdx = Math.max(0, Math.min(msgIdx, msgs.length - 1));
  const current: MessageRow | undefined = msgs[safeMsgIdx];
  const opened = useMemo(
    () => (mode === "reading" && current ? store.full(current.id) : null),
    [store, mode, current, version],
  );

  const bodyH = Math.max(3, size.rows - 4);
  const listW = Math.max(16, size.cols - SIDEBAR_W - 4);

  // Lynx-render the opened email once (cached by id+width) so it's shown
  // automatically in the reading pane; scrolling doesn't re-run lynx.
  const renderCache = useRef(new Map<string, string>());
  const readingBody = useMemo(() => {
    if (!opened) return "";
    const key = `${opened.id}:${listW}`;
    const cache = renderCache.current;
    if (!cache.has(key)) cache.set(key, renderEmailBody(opened.html, opened.body, listW));
    return cache.get(key)!;
  }, [opened, listW]);

  // Move the cursor immediately (no throttle — throttling made held keys feel
  // laggy). Synchronized-output frames keep rapid moves from tearing.
  const msgsLenRef = useRef(0);
  msgsLenRef.current = msgs.length;
  function scrollList(delta: number, resetScroll = false) {
    setMsgIdx((i) => Math.max(0, Math.min(i + delta, msgsLenRef.current - 1)));
    if (resetScroll) setScroll(0);
  }

  const targets = (): number[] =>
    selected.size > 0 ? [...selected] : current ? [current.id] : [];

  async function doBackend(label: string, fn: () => { ok: boolean; out: string } | Promise<{ ok: boolean; out: string }>) {
    if (busy) return;
    setBusy(true);
    setStatus(label + "…");
    const r = await fn();
    setSelected(new Set());
    setVersion((v) => v + 1);
    setStatus(r.ok ? r.out : `error: ${r.out.slice(0, 120)}`);
    setBusy(false);
  }

  function openInBrowser() {
    if (!current) return;
    const m = store.full(current.id);
    if (!m) return;
    const doc = m.html.trim()
      ? m.html
      : `<!doctype html><meta charset=utf-8><pre style="white-space:pre-wrap;font:14px/1.5 system-ui">${m.body
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")}</pre>`;
    const p = join(tmpdir(), "spark-ink-preview.html");
    writeFileSync(p, doc);
    spawn("open", [p], { stdio: "ignore", detached: true }).unref();
    setStatus("Opened HTML in browser");
  }

  useInput((input, key) => {
    if (isMouseSeq(input)) return; // handled by useMouse

    if (typing) {
      if (key.escape) {
        setTyping(false);
        setDraft("");
      } else if (key.return) {
        setTyping(false);
        setSearch(draft.trim() ? draft.trim() : null);
        setFocus("list");
        setMsgIdx(0);
      } else if (key.backspace || key.delete) {
        setDraft((d) => d.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setDraft((d) => d + input);
      }
      return;
    }

    if (picker) {
      if (key.escape || input === "q") setPicker(null);
      else if (input === "j" || key.downArrow) setPicker({ ...picker, idx: Math.min(picker.idx + 1, picker.options.length - 1) });
      else if (input === "k" || key.upArrow) setPicker({ ...picker, idx: Math.max(picker.idx - 1, 0) });
      else if (key.return) {
        const choice = picker.options[picker.idx]!;
        const ids = targets();
        const kind = picker.kind;
        setPicker(null);
        if (kind === "move") {
          void doBackend(`Moving ${ids.length} to ${choice}`, () => be.move(ids, choice));
        } else {
          const secs = SNOOZE_OPTIONS.find(([l]) => l === choice)?.[1] ?? 3600;
          const until = Math.floor(Date.now() / 1000) + secs;
          store.setSnooze(ids, until);
          setSelected(new Set());
          if (mode === "reading") setMode("list");
          setVersion((v) => v + 1);
          setStatus(`snoozed ${ids.length} for ${choice.toLowerCase()}`);
        }
      }
      return;
    }

    if (mode === "reading") {
      if (key.escape || input === "q" || key.backspace) {
        setMode("list");
        setScroll(0);
      } else if (input === "j" || key.downArrow) {
        setScroll((s) => s + 1); // scroll the open email, not next/prev message
      } else if (input === "k" || key.upArrow) {
        setScroll((s) => Math.max(0, s - 1));
      } else if (input === "l" || key.rightArrow) scrollList(1, true); // next email
      else if (input === "h" || key.leftArrow) scrollList(-1, true); // previous email
      else if (input === "v") openInBrowser();
      else if (input === "e") {
        setMode("list");
        setScroll(0);
        void doBackend("Archiving on server", () => be.archive(targets()));
      } else if (input === "s") {
        setPicker({ kind: "snooze", options: SNOOZE_OPTIONS.map(([l]) => l), idx: 0 });
      } else if (input === "d") {
        setMode("list");
        setScroll(0);
        void doBackend("Trashing on server", () => be.trash(targets()));
      } else if (input === "u" && current?.mailbox === "Trash") {
        setMode("list");
        setScroll(0);
        void doBackend("Restoring from Trash", () => be.untrash(targets()));
      } else if (input === "M") void doBackend("Marking read on server", () => be.mark(targets(), true));
      else if (input === "U") void doBackend("Marking unread on server", () => be.mark(targets(), false));
      return;
    }

    if (input === "q") exit();
    else if (input === "/") {
      setTyping(true);
      setDraft(search ?? "");
    } else if (key.escape && search !== null) {
      setSearch(null); // clear search, back to sidebar filter
      setMsgIdx(0);
    } else if (key.return && current) setMode("reading");
    else if (key.tab || input === "h" || input === "l" || key.leftArrow || key.rightArrow)
      setFocus(focus === "sidebar" ? "list" : "sidebar");
    else if (input === "j" || key.downArrow) {
      if (focus === "sidebar") {
        setSearch(null);
        setCatIdx(nextSelectable(entries, safeCatIdx, 1));
        setMsgIdx(0);
      } else scrollList(1);
    } else if (input === "k" || key.upArrow) {
      if (focus === "sidebar") {
        setSearch(null);
        setCatIdx(nextSelectable(entries, safeCatIdx, -1));
        setMsgIdx(0);
      } else scrollList(-1);
    } else if (input === " " && current) {
      const next = new Set(selected);
      next.has(current.id) ? next.delete(current.id) : next.add(current.id);
      setSelected(next);
      setMsgIdx(Math.min(safeMsgIdx + 1, msgs.length - 1));
    } else if (key.escape) setSelected(new Set());
    else if (input === "r") void doBackend("Fetching new mail", () => be.sync());
    else if (input === "M") void doBackend("Marking read on server", () => be.mark(targets(), true));
    else if (input === "U") void doBackend("Marking unread on server", () => be.mark(targets(), false));
    else if (input === "e" && targets().length > 0) {
      void doBackend("Archiving on server", () => be.archive(targets()));
    } else if (input === "s" && targets().length > 0) {
      setPicker({ kind: "snooze", options: SNOOZE_OPTIONS.map(([l]) => l), idx: 0 });
    } else if (input === "d" && targets().length > 0) {
      void doBackend("Trashing on server", () => be.trash(targets()));
    } else if (input === "u" && current?.mailbox === "Trash" && targets().length > 0) {
      void doBackend("Restoring from Trash", () => be.untrash(targets()));
    } else if (input === "m" && targets().length > 0) {
      const cats = [...new Set([...cfg.categories.map((c) => c.name), ...store.approvedCategories()])];
      if (cats.length > 0) setPicker({ kind: "move", options: cats, idx: 0 });
    } else if (input === "v") openInBrowser();
  });

  // ----- render -----
  const senderW = 18;
  const catW = listW < 72 ? 0 : 13;
  const dateW = 12; // "Jul 20 15:04"
  const subjW = Math.max(0, listW - (2 + 1 + senderW + 1 + (catW > 0 ? catW + 1 : 0) + dateW + 1));

  const winStart = msgs.length > bodyH ? Math.max(0, Math.min(safeMsgIdx - Math.floor(bodyH / 2), msgs.length - bodyH)) : 0;
  const visible = msgs.slice(winStart, winStart + bodyH);

  const sideStart = entries.length > bodyH ? Math.max(0, Math.min(safeCatIdx - Math.floor(bodyH / 2), entries.length - bodyH)) : 0;
  const sideVisible = entries.slice(sideStart, sideStart + bodyH);

  // Mouse: wheel scrolls, click selects. Screen layout — row 0 header, row 1
  // pane top border, content rows 2..bodyH+1; sidebar box cols 0..SIDEBAR_W+1,
  // list content begins at col SIDEBAR_W+2.
  useMouse((e) => {
    if (picker || typing) return;
    if (mode === "reading") {
      if (e.type === "wheeldown") setScroll((s) => s + 3);
      else if (e.type === "wheelup") setScroll((s) => Math.max(0, s - 3));
      return;
    }
    if (e.type === "wheeldown") {
      if (focus === "sidebar") {
        setSearch(null);
        setCatIdx((i) => nextSelectable(entries, Math.min(i, entries.length - 1), 1));
        setMsgIdx(0);
      } else scrollList(3);
      return;
    }
    if (e.type === "wheelup") {
      if (focus === "sidebar") {
        setSearch(null);
        setCatIdx((i) => nextSelectable(entries, Math.min(i, entries.length - 1), -1));
        setMsgIdx(0);
      } else scrollList(-3);
      return;
    }
    if (e.type !== "down") return;
    const contentRow = e.row - 2;
    if (contentRow < 0 || contentRow >= bodyH) return;
    if (e.col <= SIDEBAR_W + 1) {
      const abs = sideStart + contentRow;
      const target = entries[abs];
      if (target && target.kind !== "header") {
        setSearch(null);
        setFocus("sidebar");
        setCatIdx(abs);
        setMsgIdx(0);
      }
    } else {
      const abs = winStart + contentRow;
      if (abs < msgs.length) {
        setFocus("list");
        if (abs === safeMsgIdx) setMode("reading"); // click current row = open
        else setMsgIdx(abs);
      }
    }
  });

  const inTrash = activeFilter.kind === "folder" && activeFilter.class === "Trash";
  const hint =
    mode === "reading"
      ? `j/k scroll · h/l prev/next · v html${inTrash ? " · u restore" : " · e done · s snooze · d trash"} · M/U read · esc/q back`
      : `enter open${inTrash ? " · u restore" : " · e done · s snooze · d trash"} · m move · / search · r refresh · M/U read · q quit${selected.size > 0 ? ` · ${selected.size} selected` : ""}`;

  const headerNote = typing
    ? `  /${draft}▏` + (draft === "" ? "  from: subj: body: is:unread has:attachment in:sent" : "")
    : search !== null
      ? `  search: "${search}" (${msgs.length}) · esc clear`
      : "  " + status;

  return (
    <Box flexDirection="column" width={size.cols} height={size.rows}>
      <Box>
        <Text color={PINK} bold>
          spark-ink
        </Text>
        <Text color={typing ? BLUE : DIM}>{fit(headerNote, size.cols - 9)}</Text>
      </Box>

      <Box>
        {/* sidebar */}
        <Box
          width={SIDEBAR_W + 2}
          height={bodyH + 2}
          borderStyle="round"
          borderColor={focus === "sidebar" && mode === "list" ? PINK : "gray"}
          flexDirection="column"
          overflow="hidden"
        >
          {sideVisible.map((e, i) => {
            const abs = sideStart + i;
            if (e.kind === "header")
              return (
                <Text key={abs} color={BLUE} bold>
                  {fit(`── ${e.label} `, SIDEBAR_W)}
                </Text>
              );
            const sel = abs === safeCatIdx;
            return (
              <Text key={abs} backgroundColor={sel ? PINK : undefined} color={sel ? "black" : undefined}>
                {fit(e.label, SIDEBAR_W)}
              </Text>
            );
          })}
        </Box>

        {/* right pane */}
        <Box
          width={listW + 2}
          height={bodyH + 2}
          borderStyle="round"
          borderColor={mode === "reading" || focus === "list" ? PINK : "gray"}
          flexDirection="column"
          overflow="hidden"
        >
          {mode === "reading" && opened ? (
            <Reading opened={opened} body={readingBody} scroll={scroll} w={listW} h={bodyH} />
          ) : msgs.length === 0 ? (
            <Text color={DIM}>{search !== null ? `no matches for "${search}"` : "(empty)"}</Text>
          ) : (
            visible.map((m, i) => {
              const abs = winStart + i;
              const cursor = abs === safeMsgIdx;
              const selCh = selected.has(m.id) ? "●" : " ";
              const readCh = m.seen ? " " : "•";
              const bot = isBot(m.from_addr);
              const sender = fit(oneLine(m.from_name || m.from_addr), senderW);
              const cat = catW > 0 ? fit(m.category || "—", catW) : "";
              const subj = fit(oneLine(m.subject) || "(no subject)", subjW);
              const d = new Date(m.date * 1000);
              const date = fit(
                d.toLocaleDateString("en-US", { month: "short", day: "2-digit" }) +
                  " " +
                  d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
                dateW,
              );
              if (cursor)
                return (
                  <Text key={m.id} backgroundColor={PINK} color="black">
                    {fit(`${selCh}${readCh} ${sender} ${cat}${catW > 0 ? " " : ""}${subj} ${date}`, listW)}
                  </Text>
                );
              return (
                <Text key={m.id} bold={!m.seen}>
                  <Text color={PINK}>{selCh}</Text>
                  {readCh + " "}
                  <Text color={bot ? DIM : HUMAN}>{sender + " "}</Text>
                  {catW > 0 && <Text color={CAT}>{cat + " "}</Text>}
                  {subj + " "}
                  <Text color={DIM}>{date}</Text>
                </Text>
              );
            })
          )}
        </Box>
      </Box>

      <Text color={DIM}>{fit(hint, size.cols)}</Text>

      {picker &&
        (() => {
          // Window the options so a long list (many URLs) fits on screen, and
          // clamp the box position so it never renders off the top.
          const maxRows = Math.max(3, Math.min(picker.options.length, size.rows - 6));
          const w = 30;
          const start = Math.max(0, Math.min(picker.idx - Math.floor(maxRows / 2), picker.options.length - maxRows));
          const shown = picker.options.slice(start, start + maxRows);
          const boxH = maxRows + 4;
          return (
            <Box
              position="absolute"
              marginLeft={Math.max(1, Math.floor((size.cols - w) / 2) - 3)}
              marginTop={Math.max(1, Math.floor((size.rows - boxH) / 2))}
              borderStyle="round"
              borderColor={PINK}
              flexDirection="column"
              paddingX={2}
            >
              <Text color={PINK} bold>
                {picker.kind === "snooze" ? "Snooze until" : "Move"}
                {` (${targets().length} email(s))`}:
              </Text>
              {shown.map((o, i) => {
                const abs = start + i;
                return (
                  <Text key={abs} backgroundColor={abs === picker.idx ? PINK : undefined} color={abs === picker.idx ? "black" : undefined}>
                    {fit((abs === picker.idx ? "> " : "  ") + o, w)}
                  </Text>
                );
              })}
              <Text color={DIM}>j/k move · enter choose · esc cancel</Text>
            </Box>
          );
        })()}
    </Box>
  );
}

function Reading({ opened, body: bodyText, scroll, w, h }: { opened: NonNullable<ReturnType<Store["full"]>>; body: string; scroll: number; w: number; h: number }) {
  const atts: { name: string; type: string; size: number }[] = opened.attachments
    ? JSON.parse(opened.attachments)
    : [];
  const head = [
    `Mailbox: ${opened.account}`,
    `From:    ${opened.from_name} <${opened.from_addr}>`,
    `Subject: ${oneLine(opened.subject)}`,
    `Date:    ${new Date(opened.date * 1000).toLocaleString("en-GB")}`,
    `Category: ${opened.category || "Uncategorized"}${opened.source ? `  [${opened.source}]` : ""}`,
    ...(opened.html.trim() ? ["HTML email — v browser"] : []),
    ...atts.map((a) => `📎 ${a.name}  ${a.type}  ${(a.size / 1024).toFixed(0)} KB`),
    "─".repeat(Math.max(10, w)),
    "",
  ];
  const body = (bodyText || "").split("\n").map((l) => oneLine(l));
  const lines = [...head, ...body].slice(scroll, scroll + h);
  return (
    <>
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
    </>
  );
}
