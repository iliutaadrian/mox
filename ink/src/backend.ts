// Actions the TUI triggers, run IN-PROCESS (no subprocess). Each returns
// {ok, out} for the status line. Writes to the server happen only in mark().
import { Store, CLASS_INBOX } from "./db.ts";
import { addSenderRule, loadConfig, type Account, type Config } from "./config.ts";
import { refresh, applyRules } from "./engine.ts";
import { detectFolders, setSeen } from "./mail.ts";

export type Result = { ok: boolean; out: string };

function accByName(cfg: Config): Map<string, Account> {
  return new Map(cfg.accounts.map((a) => [a.name, a]));
}

// Resolve a folder class to its real IMAP name for an account (cached per call).
async function folderName(cache: Map<string, Map<string, string>>, acc: Account, cls: string): Promise<string> {
  if (cls === CLASS_INBOX) return acc.mailbox;
  let m = cache.get(acc.name);
  if (!m) {
    m = new Map((await detectFolders(acc)).map((f) => [f.class, f.name]));
    cache.set(acc.name, m);
  }
  return m.get(cls) ?? acc.mailbox;
}

export function backend(store: Store, cfg: Config, cfgPath: string) {
  return {
    // Interactive refresh: INBOX only (fast). Folders sync via `cli sync`.
    async sync(): Promise<Result> {
      try {
        const { fetched, filed } = await refresh(store, cfg, true);
        return { ok: true, out: `fetched ${fetched}, filed ${filed} by rules` };
      } catch (e) {
        return { ok: false, out: String(e) };
      }
    },

    async mark(ids: number[], seen: boolean): Promise<Result> {
      try {
        const rows = store.byIds(ids);
        const accs = accByName(cfg);
        const cache = new Map<string, Map<string, string>>();
        // Group ids by (account, mailbox class).
        const groups = new Map<string, { acc: Account; cls: string; uids: number[]; ids: number[] }>();
        for (const r of rows) {
          const acc = accs.get(r.account);
          if (!acc) continue;
          const key = `${r.account}\0${r.mailbox}`;
          let g = groups.get(key);
          if (!g) {
            g = { acc, cls: r.mailbox, uids: [], ids: [] };
            groups.set(key, g);
          }
          g.uids.push(r.uid);
          g.ids.push(r.id);
        }
        let n = 0;
        for (const g of groups.values()) {
          const name = await folderName(cache, g.acc, g.cls);
          await setSeen(g.acc, name, g.uids, seen);
          for (const id of g.ids) store.setSeenLocal(id, seen);
          n += g.uids.length;
        }
        return { ok: true, out: `marked ${n} ${seen ? "read" : "unread"}` };
      } catch (e) {
        return { ok: false, out: String(e) };
      }
    },

    move(ids: number[], category: string): Result {
      try {
        store.setCategoryManual(ids, category);
        return { ok: true, out: `moved ${ids.length} to ${category}` };
      } catch (e) {
        return { ok: false, out: String(e) };
      }
    },

    // Create a sender-domain rule from the given messages' senders, persist it
    // to config.yaml, then re-home matching INBOX mail. Returns the reloaded
    // config (caller swaps it in) plus a result.
    rule(ids: number[], category: string): { res: Result; cfg?: Config } {
      try {
        const rows = store.byIds(ids);
        const full = rows.map((r) => store.full(r.id)).filter(Boolean);
        const domains = new Set<string>();
        for (const m of full) {
          const addr = (m!.from_addr || "").toLowerCase();
          const i = addr.lastIndexOf("@");
          if (i >= 0) domains.add(addr.slice(i + 1));
        }
        if (domains.size === 0) return { res: { ok: false, out: "no sender domains in selection" } };
        addSenderRule(cfgPath, category, [...domains].sort(), []);
        // Reload config from disk and apply.
        const reloaded = loadConfig(cfgPath);
        const n = applyRules(store, reloaded);
        return { res: { ok: true, out: `rule: ${[...domains].join(", ")} → ${category} (${n} moved)` }, cfg: reloaded };
      } catch (e) {
        return { res: { ok: false, out: String(e) } };
      }
    },
  };
}
