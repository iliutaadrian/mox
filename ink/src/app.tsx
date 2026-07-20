// spark-ink — Ink/React TUI over the Go spark-cli backend. Layout and
// keybindings mirror the Go TUI: sidebar (All / mailboxes / manual / other),
// message list, reading view. Reads sqlite directly; every write shells out to
// the Go binary. Filing is by sender rules only — no AI classification.
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store, type Filter, type MessageRow } from "./db.ts";
import { loadConfig, type Config } from "./config.ts";
import { backend } from "./backend.ts";
import { fit, oneLine } from "./text.ts";
import { useMouse, isMouseSeq } from "./mouse.ts";

const SIDEBAR_W = 26;
const PINK = "#ff5faf";
const BLUE = "#00afff";
const DIM = "#808080";
const CAT = "#87afaf";

type SideEntry =
  | { kind: "all"; label: string }
  | { kind: "header"; label: string }
  | { kind: "account"; name: string; label: string }
  | { kind: "category"; name: string; label: string };

function buildSidebar(store: Store, cfg: Config): SideEntry[] {
  const accCounts = store.accountCounts();
  const catCounts = store.categoryCounts();
  const entries: SideEntry[] = [{ kind: "all", label: `All (${store.totalCount()})` }];

  const accounts = cfg.accounts.filter((a) => (accCounts.get(a) ?? 0) > 0);
  if (accounts.length > 1) {
    entries.push({ kind: "header", label: "Mailboxes" });
    for (const a of accounts)
      entries.push({ kind: "account", name: a, label: `${a} (${accCounts.get(a)})` });
  }

  const manual = cfg.categories.filter((c) => c.hasRules && (catCounts.get(c.name) ?? 0) > 0);
  if (manual.length > 0) {
    entries.push({ kind: "header", label: "Manual" });
    for (const c of manual)
      entries.push({ kind: "category", name: c.name, label: `${c.name} (${catCounts.get(c.name)})` });
  }

  const aiNames = new Set<string>();
  for (const c of cfg.categories) if (!c.hasRules && (catCounts.get(c.name) ?? 0) > 0) aiNames.add(c.name);
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
  return entries;
}

function filterOf(e: SideEntry): Filter {
  if (e.kind === "account") return { kind: "account", name: e.name };
  if (e.kind === "category") return { kind: "category", name: e.name };
  return { kind: "all" };
}

function nextSelectable(entries: SideEntry[], idx: number, dir: 1 | -1): number {
  let i = idx + dir;
  while (i >= 0 && i < entries.length) {
    if (entries[i]!.kind !== "header") return i;
    i += dir;
  }
  return idx;
}

export function App({ repoRoot, dbPath, cfgPath }: { repoRoot: string; dbPath: string; cfgPath: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const be = useMemo(() => backend(repoRoot), [repoRoot]);
  const store = useMemo(() => new Store(dbPath), [dbPath]);
  const cfg = useMemo(() => loadConfig(cfgPath), [cfgPath]);

  const [size, setSize] = useState({ cols: stdout.columns, rows: stdout.rows });
  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);

  const [version, setVersion] = useState(0); // bump after writes to re-query
  const [catIdx, setCatIdx] = useState(0);
  const [msgIdx, setMsgIdx] = useState(0);
  const [focus, setFocus] = useState<"sidebar" | "list">("sidebar");
  const [mode, setMode] = useState<"list" | "reading">("list");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState("Press r to fetch new mail");
  const [busy, setBusy] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [picker, setPicker] = useState<{ options: string[]; idx: number } | null>(null);
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

  const targets = (): number[] =>
    selected.size > 0 ? [...selected] : current ? [current.id] : [];

  async function doBackend(label: string, fn: () => Promise<{ ok: boolean; out: string }>) {
    if (busy) return;
    setBusy(true);
    setStatus(label + "…");
    const r = await fn();
    store.reopen(dbPath);
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
        const cat = picker.options[picker.idx]!;
        const ids = targets();
        setPicker(null);
        void doBackend(`Moving ${ids.length} to ${cat}`, () => be.move(ids, cat));
      }
      return;
    }

    if (mode === "reading") {
      if (key.escape || input === "q" || input === "h" || key.leftArrow || key.backspace) {
        setMode("list");
        setScroll(0);
      } else if (input === "j" || key.downArrow) {
        setMsgIdx(Math.min(safeMsgIdx + 1, msgs.length - 1));
        setScroll(0);
      } else if (input === "k" || key.upArrow) {
        setMsgIdx(Math.max(safeMsgIdx - 1, 0));
        setScroll(0);
      } else if (key.ctrl && input === "d") setScroll((s) => s + Math.floor(bodyH / 2));
      else if (key.ctrl && input === "u") setScroll((s) => Math.max(0, s - Math.floor(bodyH / 2)));
      else if (input === "v") openInBrowser();
      else if (input === "M") void doBackend("Marking read on server", () => be.mark(targets(), true));
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
      } else setMsgIdx(Math.min(safeMsgIdx + 1, msgs.length - 1));
    } else if (input === "k" || key.upArrow) {
      if (focus === "sidebar") {
        setSearch(null);
        setCatIdx(nextSelectable(entries, safeCatIdx, -1));
        setMsgIdx(0);
      } else setMsgIdx(Math.max(safeMsgIdx - 1, 0));
    } else if (input === " " && current) {
      const next = new Set(selected);
      next.has(current.id) ? next.delete(current.id) : next.add(current.id);
      setSelected(next);
      setMsgIdx(Math.min(safeMsgIdx + 1, msgs.length - 1));
    } else if (key.escape) setSelected(new Set());
    else if (input === "r") void doBackend("Fetching new mail", () => be.sync());
    else if (input === "M") void doBackend("Marking read on server", () => be.mark(targets(), true));
    else if (input === "U") void doBackend("Marking unread on server", () => be.mark(targets(), false));
    else if (input === "m" && targets().length > 0) {
      const cats = [...new Set([...cfg.categories.map((c) => c.name), ...store.approvedCategories()])];
      if (cats.length > 0) setPicker({ options: cats, idx: 0 });
    } else if (input === "v") openInBrowser();
  });

  // ----- render -----
  const senderW = 18;
  const catW = listW < 72 ? 0 : 13;
  const dateW = 6;
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
      } else setMsgIdx((i) => Math.min(i + 3, msgs.length - 1));
      return;
    }
    if (e.type === "wheelup") {
      if (focus === "sidebar") {
        setSearch(null);
        setCatIdx((i) => nextSelectable(entries, Math.min(i, entries.length - 1), -1));
        setMsgIdx(0);
      } else setMsgIdx((i) => Math.max(i - 3, 0));
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

  const hint =
    mode === "reading"
      ? "j/k next/prev · ctrl+u/d scroll · v html · M/U read/unread · esc/q back"
      : `enter open · / search · space select · r refresh · m move · q quit${selected.size > 0 ? ` · ${selected.size} selected` : ""}`;

  const headerNote = typing
    ? `  /${draft}▏`
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
            <Reading opened={opened} scroll={scroll} w={listW} h={bodyH} />
          ) : msgs.length === 0 ? (
            <Text color={DIM}>{search !== null ? `no matches for "${search}"` : "(empty)"}</Text>
          ) : (
            visible.map((m, i) => {
              const abs = winStart + i;
              const cursor = abs === safeMsgIdx;
              const selCh = selected.has(m.id) ? "●" : " ";
              const readCh = m.seen ? " " : "•";
              const sender = fit(oneLine(m.from_name || m.from_addr), senderW);
              const cat = catW > 0 ? fit(m.category || "—", catW) : "";
              const subj = fit(oneLine(m.subject) || "(no subject)", subjW);
              const date = fit(
                new Date(m.date * 1000).toLocaleDateString("en-US", { month: "short", day: "2-digit" }),
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
                  {readCh + " " + sender + " "}
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

      {picker && (
        <Box
          position="absolute"
          marginLeft={Math.floor(size.cols / 2) - 18}
          marginTop={Math.floor(size.rows / 2) - Math.floor(picker.options.length / 2) - 2}
          borderStyle="round"
          borderColor={PINK}
          flexDirection="column"
          paddingX={2}
          paddingY={1}
        >
          <Text color={PINK} bold>
            Move {targets().length} email(s) to:
          </Text>
          {picker.options.map((o, i) => (
            <Text key={o} backgroundColor={i === picker.idx ? PINK : undefined} color={i === picker.idx ? "black" : undefined}>
              {fit((i === picker.idx ? "> " : "  ") + o, 30)}
            </Text>
          ))}
          <Text color={DIM}>j/k move · enter choose · esc cancel</Text>
        </Box>
      )}
    </Box>
  );
}

function Reading({ opened, scroll, w, h }: { opened: NonNullable<ReturnType<Store["full"]>>; scroll: number; w: number; h: number }) {
  const atts: { name: string; type: string; size: number }[] = opened.attachments
    ? JSON.parse(opened.attachments)
    : [];
  const head = [
    `Mailbox: ${opened.account}`,
    `From:    ${opened.from_name} <${opened.from_addr}>`,
    `Subject: ${oneLine(opened.subject)}`,
    `Date:    ${new Date(opened.date * 1000).toLocaleString("en-GB")}`,
    `Category: ${opened.category || "Uncategorized"}${opened.source ? `  [${opened.source}]` : ""}`,
    ...(opened.html.trim() ? ["HTML email — press v to open it in your browser"] : []),
    ...atts.map((a) => `📎 ${a.name}  ${a.type}  ${(a.size / 1024).toFixed(0)} KB`),
    "─".repeat(Math.max(10, w)),
    "",
  ];
  const body = (opened.body || "").split("\n").map((l) => oneLine(l));
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
