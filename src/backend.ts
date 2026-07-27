// Actions the TUI triggers, run IN-PROCESS (no subprocess). Each returns
// {ok, out} for the status line. Writes to the server happen only in mark().
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Store, CLASS_INBOX, CLASS_TRASH, CLASS_ARCHIVE } from "./db.ts";
import { type Account, type Config } from "./config.ts";
import { refresh } from "./engine.ts";
import { detectFolders, setSeen, trashMessages, untrashMessages, archiveMessages, unarchiveMessages, reconcileFolders, fetchBody, fetchAllAttachments, appendDraft } from "./mail.ts";
import { buildDraftMime, replySubject } from "./compose.ts";

export type Result = { ok: boolean; out: string };

export type DraftParams = {
  body: string; // plain text; blank lines separate paragraphs
  replyTo?: number; // local message id — derives account/to/subject/threading
  account?: string; // standalone: which account to draft from (default: first)
  to?: string; // standalone: required; reply: overrides the original sender
  subject?: string; // standalone: required; reply: overrides "Re: <original>"
};

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

export function backend(store: Store, cfg: Config) {
  return {
    // Interactive refresh: INBOX + Sent (fast). Other folders sync via `cli sync`.
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

    // Compose a draft and append it to the account's IMAP Drafts folder (mox
    // never sends — review + send happens in the provider's own UI). Either a
    // reply to a stored message (replyTo threads via In-Reply-To/References)
    // or standalone (account/to/subject given explicitly).
    async draft(p: DraftParams): Promise<Result> {
      try {
        if (!p.body?.trim()) return { ok: false, out: "draft body is empty" };
        const accs = accByName(cfg);
        let acc: Account | undefined;
        let to = p.to ?? "";
        let subject = p.subject ?? "";
        let inReplyTo: string | undefined;
        if (p.replyTo != null) {
          const orig = store.full(p.replyTo);
          if (!orig) return { ok: false, out: `message ${p.replyTo} not found` };
          acc = accs.get(orig.account);
          if (!acc) return { ok: false, out: `account ${orig.account} not in config` };
          to ||= orig.from_addr;
          subject ||= replySubject(orig.subject);
          inReplyTo = orig.message_id || undefined;
        } else {
          acc = p.account ? accs.get(p.account) : cfg.accounts[0];
          if (!acc) return { ok: false, out: `account ${p.account ?? "(none)"} not in config` };
          if (!to) return { ok: false, out: "standalone draft needs a to address" };
          if (!subject) return { ok: false, out: "standalone draft needs a subject" };
        }
        const mime = buildDraftMime({ from: acc.imapUser, to, subject, text: p.body, inReplyTo });
        const { folder } = await appendDraft(acc, mime);
        return { ok: true, out: `draft "${subject}" saved to ${acc.name}/${folder} — send it from your mail app` };
      } catch (e) {
        return { ok: false, out: String(e) };
      }
    },

    // Fetch a message's body/html on demand (older mail keeps only metadata).
    async body(id: number): Promise<{ ok: boolean; body: string; html: string }> {
      try {
        const row = store.byIds([id])[0];
        const acc = row && accByName(cfg).get(row.account);
        if (!row || !acc) return { ok: false, body: "", html: "" };
        const name = await folderName(new Map(), acc, row.mailbox);
        const { text, html } = await fetchBody(acc, name, row.uid);
        return { ok: true, body: text, html };
      } catch {
        return { ok: false, body: "", html: "" };
      }
    },

    // Download a message's attachments to ./Attachments (under the directory
    // mox was launched from). One file → straight into Attachments; multiple →
    // a subfolder named after the email so they stay grouped. Name collisions
    // get " (2)", " (3)" … suffixes.
    async download(id: number): Promise<Result> {
      try {
        const row = store.byIds([id])[0];
        const full = store.full(id);
        const acc = row && accByName(cfg).get(row.account);
        if (!row || !acc) return { ok: false, out: "message not found" };
        const name = await folderName(new Map(), acc, row.mailbox);
        const atts = await fetchAllAttachments(acc, name, row.uid);
        if (atts.length === 0) return { ok: true, out: "no attachments" };

        const uniquePath = (base: string, fname: string) => {
          const safe = fname.replace(/[/\\]/g, "-");
          let dest = join(base, safe);
          if (existsSync(dest)) {
            const dot = safe.lastIndexOf(".");
            const stem = dot > 0 ? safe.slice(0, dot) : safe;
            const ext = dot > 0 ? safe.slice(dot) : "";
            let i = 2;
            while (existsSync((dest = join(base, `${stem} (${i})${ext}`)))) i++;
          }
          return dest;
        };

        const base = join(process.cwd(), "Attachments");
        let outDir = base;
        if (atts.length > 1) {
          // Folder name from the subject (fallback sender), sanitized + trimmed.
          const label = (full?.subject?.trim() || full?.from_name || row.account || "email")
            .replace(/[/\\:*?"<>|]/g, "-")
            .replace(/\s+/g, " ")
            .slice(0, 80)
            .trim();
          outDir = uniquePath(base, label); // reuse collision logic for the dir too
          mkdirSync(outDir, { recursive: true });
        } else {
          mkdirSync(base, { recursive: true });
        }

        for (const a of atts) writeFileSync(uniquePath(outDir, a.filename), a.data);
        const where = atts.length > 1 ? `Attachments/${outDir.slice(base.length + 1)}/` : "Attachments/";
        return { ok: true, out: `downloaded ${atts.length} attachment${atts.length > 1 ? "s" : ""} to ${where}` };
      } catch (e) {
        return { ok: false, out: String(e) };
      }
    },
  };
}
