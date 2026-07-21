// Actions the TUI triggers, run IN-PROCESS (no subprocess). Each returns
// {ok, out} for the status line. Writes to the server happen only in mark().
import { Store, CLASS_INBOX, CLASS_TRASH, CLASS_ARCHIVE } from "./db.ts";
import { addSenderRule, loadConfig, type Account, type Config } from "./config.ts";
import { refresh, applyRules } from "./engine.ts";
import { detectFolders, setSeen, trashMessages, untrashMessages, archiveMessages, unarchiveMessages, reconcileFolders } from "./mail.ts";

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
        // Keep Trash/Archive in step with the server (removal-only, cheap).
        await Promise.all(
          cfg.accounts.map((a) => reconcileFolders(store, a, [CLASS_TRASH, CLASS_ARCHIVE]).catch(() => {})),
        );
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

    // Move messages to the server Trash folder, then relabel the local rows to
    // Trash (with their new server UIDs) so they move into the Trash view live.
    async trash(ids: number[]): Promise<Result> {
      try {
        const rows = store.byIds(ids);
        const accs = accByName(cfg);
        const cache = new Map<string, Map<string, string>>();
        const groups = new Map<string, { acc: Account; cls: string; rows: typeof rows }>();
        for (const r of rows) {
          const acc = accs.get(r.account);
          if (!acc) continue;
          const key = `${r.account}\0${r.mailbox}`;
          let g = groups.get(key);
          if (!g) {
            g = { acc, cls: r.mailbox, rows: [] };
            groups.set(key, g);
          }
          g.rows.push(r);
        }
        let n = 0;
        for (const g of groups.values()) {
          const name = await folderName(cache, g.acc, g.cls);
          const uidMap = await trashMessages(g.acc, name, g.rows.map((r) => r.uid));
          for (const r of g.rows) {
            const nu = uidMap.get(r.uid);
            if (nu) store.setMailboxUid(r.id, CLASS_TRASH, nu);
            else store.deleteByIds([r.id]); // no UIDPLUS: drop, reappears on sync
            n++;
          }
        }
        return { ok: true, out: `trashed ${n}` };
      } catch (e) {
        return { ok: false, out: String(e) };
      }
    },

    // Move messages to the server Archive folder, relabel local rows to Archive
    // (with new UIDs) — they leave the inbox and show up under the DONE view.
    async archive(ids: number[]): Promise<Result> {
      try {
        const rows = store.byIds(ids);
        const accs = accByName(cfg);
        const cache = new Map<string, Map<string, string>>();
        const groups = new Map<string, { acc: Account; cls: string; rows: typeof rows }>();
        for (const r of rows) {
          const acc = accs.get(r.account);
          if (!acc) continue;
          const key = `${r.account}\0${r.mailbox}`;
          let g = groups.get(key);
          if (!g) {
            g = { acc, cls: r.mailbox, rows: [] };
            groups.set(key, g);
          }
          g.rows.push(r);
        }
        let n = 0;
        for (const g of groups.values()) {
          const name = await folderName(cache, g.acc, g.cls);
          const uidMap = await archiveMessages(g.acc, name, g.rows.map((r) => r.uid));
          for (const r of g.rows) {
            const nu = uidMap.get(r.uid);
            if (nu) store.setMailboxUid(r.id, CLASS_ARCHIVE, nu);
            else store.deleteByIds([r.id]);
            n++;
          }
        }
        return { ok: true, out: `archived ${n}` };
      } catch (e) {
        return { ok: false, out: String(e) };
      }
    },

    // Restore messages from the server Archive back to the INBOX, keeping their
    // existing category. Relabel local rows to INBOX with their new UIDs.
    async unarchive(ids: number[]): Promise<Result> {
      try {
        const rows = store.byIds(ids);
        const accs = accByName(cfg);
        const byAcc = new Map<string, { acc: Account; rows: typeof rows }>();
        for (const r of rows) {
          const acc = accs.get(r.account);
          if (!acc) continue;
          let g = byAcc.get(r.account);
          if (!g) {
            g = { acc, rows: [] };
            byAcc.set(r.account, g);
          }
          g.rows.push(r);
        }
        let n = 0;
        for (const g of byAcc.values()) {
          const uidMap = await unarchiveMessages(g.acc, g.rows.map((r) => r.uid));
          for (const r of g.rows) {
            const nu = uidMap.get(r.uid);
            if (nu) store.setMailboxUid(r.id, CLASS_INBOX, nu);
            else store.deleteByIds([r.id]);
            n++;
          }
        }
        return { ok: true, out: `unarchived ${n} to inbox` };
      } catch (e) {
        return { ok: false, out: String(e) };
      }
    },

    // Restore messages from the server Trash back to the INBOX and relabel the
    // local rows to INBOX (with their new UIDs) so they show up immediately.
    async untrash(ids: number[]): Promise<Result> {
      try {
        const rows = store.byIds(ids);
        const accs = accByName(cfg);
        const byAcc = new Map<string, { acc: Account; rows: typeof rows }>();
        for (const r of rows) {
          const acc = accs.get(r.account);
          if (!acc) continue;
          let g = byAcc.get(r.account);
          if (!g) {
            g = { acc, rows: [] };
            byAcc.set(r.account, g);
          }
          g.rows.push(r);
        }
        let n = 0;
        for (const g of byAcc.values()) {
          const uidMap = await untrashMessages(g.acc, g.rows.map((r) => r.uid));
          for (const r of g.rows) {
            const nu = uidMap.get(r.uid);
            if (nu) store.setMailboxUid(r.id, CLASS_INBOX, nu);
            else store.deleteByIds([r.id]); // no UIDPLUS: drop, reappears on sync
            n++;
          }
        }
        return { ok: true, out: `restored ${n} to inbox` };
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
