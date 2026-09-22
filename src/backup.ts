// Scheduled local snapshots of the SQLite store, written to `backup_dir` from
// the config — by default a `backup/` folder next to the database itself. The
// whole mailbox — categories, done
// flags, snooze times — lives ONLY in that one file and is never mirrored on the
// mail server, so losing it is unrecoverable.
//
// The schedule carries no persisted state: "is a backup due" is answered by the
// mtime of the newest file already in the folder, which stays correct across
// restarts and survives someone deleting the folder by hand.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Config } from "./config.ts";

export type BackupResult = {
  made: boolean;
  path?: string;
  pruned: number;
  /** Set when the attempt failed; the caller logs it and carries on. */
  error?: string;
};

/** backupDir is `backup_dir` from the config when set, otherwise derived from
 * the resolved db path — never hardcoded. */
export function backupDir(dbPath: string, cfg?: { backupDir?: string }): string {
  return cfg?.backupDir || join(dirname(dbPath), "backup");
}

// Backups are named "<db stem>-YYYYMMDD-HHMMSS.db" (local time, so the name
// matches the clock the user reads) — lexical order is chronological order.
// Pruning only ever considers files matching this exact shape, so anything else
// living in the folder is left untouched.
function pattern(dbPath: string): { stem: string; re: RegExp } {
  const stem = basename(dbPath).replace(/\.[^.]+$/, "") || "mox";
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { stem, re: new RegExp(`^${escaped}-\\d{8}-\\d{6}\\.db$`) };
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export type BackupFile = { name: string; path: string; mtimeMs: number };

/** listBackups returns this db's backups in the folder, newest first. */
export function listBackups(dbPath: string, cfg?: { backupDir?: string }): BackupFile[] {
  const dir = backupDir(dbPath, cfg);
  if (!existsSync(dir)) return [];
  const { re } = pattern(dbPath);
  const out: BackupFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!re.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile()) out.push({ name, path, mtimeMs: st.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
}

/**
 * maybeBackup snapshots the store if one is due, then prunes to `backup_keep`.
 * Cheap and idempotent: with a recent backup on disk it does a single readdir and
 * returns. Never throws — a full disk or an unwritable folder must not stop the
 * client from opening, so failures come back as `error`.
 */
export function maybeBackup(dbPath: string, cfg: Config, now = Date.now()): BackupResult {
  if (!cfg.backupEnabled) return { made: false, pruned: 0 };

  try {
    if (!existsSync(dbPath)) return { made: false, pruned: 0 };

    const existing = listBackups(dbPath, cfg);
    const newest = existing[0];
    if (newest && now - newest.mtimeMs < cfg.backupEveryHours * 3_600_000) {
      return { made: false, pruned: 0 };
    }

    const dir = backupDir(dbPath, cfg);
    mkdirSync(dir, { recursive: true });
    const { stem } = pattern(dbPath);
    const target = join(dir, `${stem}-${stamp(new Date(now))}.db`);
    // VACUUM INTO refuses to overwrite; a same-second collision means a snapshot
    // already exists for this instant, which is as good as the one we'd write.
    if (existsSync(target)) return { made: false, pruned: 0 };

    // VACUUM INTO, never a file copy: the store runs in WAL mode, so the .db file
    // on its own is missing everything still in the -wal sidecar. Copying the
    // three files unsynchronised yields a torn snapshot that silently loses (or
    // corrupts) recent writes. VACUUM INTO writes one consistent, compacted
    // database from inside a read transaction.
    const db = new Database(dbPath, { readonly: true });
    try {
      db.exec(`VACUUM INTO ${quote(target)}`);
    } finally {
      db.close();
    }

    return { made: true, path: target, pruned: prune(dbPath, cfg.backupKeep, cfg) };
  } catch (e) {
    return { made: false, pruned: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** prune deletes all but the `keep` newest backups. Returns how many it removed. */
export function prune(dbPath: string, keep: number, cfg?: { backupDir?: string }): number {
  const n = Math.max(1, Math.floor(keep) || 1);
  let pruned = 0;
  for (const f of listBackups(dbPath, cfg).slice(n)) {
    try {
      rmSync(f.path, { force: true });
      pruned++;
    } catch {}
  }
  return pruned;
}

// VACUUM INTO takes a string literal, not a bindable parameter.
function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
