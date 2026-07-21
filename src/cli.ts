// Headless CLI for scripted/bulk operations without the TUI. Runs one action
// and exits. Useful for large backfills (raise fetch_since_days, run sync) that
// would otherwise block the interactive UI.
//
//   bun ink/src/cli.ts sync                 fetch all folders + rule-file
//   bun ink/src/cli.ts attach <id> [name]   download an attachment to cwd
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

import { Store, CLASS_INBOX } from "./db.ts";
import { loadConfig } from "./config.ts";
import { refresh } from "./engine.ts";
import { detectFolders, fetchAttachment } from "./mail.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath = process.env.SPARK_CONFIG ?? join(repoRoot, "config.yaml");
const store = new Store(process.env.SPARK_DB ?? join(dirname(cfgPath), "spark-cli.db"));
const cfg = loadConfig(cfgPath);

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "sync": {
    const { fetched, filed } = await refresh(store, cfg);
    console.log(`fetched=${fetched} filed=${filed}`);
    break;
  }
  case "attach": {
    const id = Number(rest[0]);
    const name = rest[1] ?? "";
    const row = store.byIds([id])[0];
    if (!row) throw new Error(`unknown id ${id}`);
    const acc = cfg.accounts.find((a) => a.name === row.account);
    if (!acc) throw new Error(`account ${row.account} not in config`);
    let imapName = acc.mailbox;
    if (row.mailbox !== CLASS_INBOX) {
      imapName = (await detectFolders(acc)).find((f) => f.class === row.mailbox)?.name ?? acc.mailbox;
    }
    const { data, filename } = await fetchAttachment(acc, imapName, row.uid, name);
    const out = filename.replace(/[/\\]/g, "-");
    writeFileSync(out, data);
    console.log(`saved ${out} (${data.length} bytes)`);
    break;
  }
  default:
    console.error("usage: cli.ts sync | attach <id> [name]");
    process.exit(2);
}
store.close();
process.exit(0);
