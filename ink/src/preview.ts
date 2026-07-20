// Standalone email previewer: renders one message's real HTML to a PNG (Chrome
// headless) and paints it inline in the terminal via chafa (kitty graphics in
// Ghostty, sixel/symbols elsewhere). Invoked by the Ink app on the `i` key with
// stdio inherited, so it owns the terminal until a key is pressed.
//
//   bun preview.ts <dbPath> <id>
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync, openSync, readSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [dbPath, idArg] = process.argv.slice(2);
if (!dbPath || !idArg) {
  console.error("usage: preview.ts <dbPath> <id>");
  process.exit(2);
}

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const chrome = CHROME_CANDIDATES.find(existsSync);

const db = new Database(dbPath, { readonly: true });
const row = db
  .query("SELECT COALESCE(html,'') AS html, COALESCE(body,'') AS body, COALESCE(subject,'') AS subject FROM messages WHERE id = ?")
  .get(Number(idArg)) as { html: string; body: string; subject: string } | null;
if (!row) {
  console.error("message not found");
  process.exit(1);
}

const cols = process.stdout.columns || 100;
const rows = process.stdout.rows || 30;

function waitKey() {
  process.stdout.write("\n\x1b[2m— press any key to return —\x1b[0m");
  try {
    const fd = openSync("/dev/tty", "r");
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, null);
    closeSync(fd);
  } catch {
    /* no tty — just return */
  }
}

// Text-only email: nothing to rasterize, print the text and bail.
if (!row.html.trim()) {
  process.stdout.write("\x1b[2J\x1b[H");
  console.log(row.body || "(empty body)");
  waitKey();
  process.exit(0);
}

if (!chrome) {
  console.error("no Chrome/Chromium found to render HTML — install one or use v (browser)");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "spark-preview-"));
const htmlPath = join(dir, "mail.html");
const pngPath = join(dir, "mail.png");
// White background so dark-mode terminals don't invert the email; wide enough
// for typical newsletter layouts, tall window to capture most of the message.
writeFileSync(
  htmlPath,
  `<!doctype html><meta charset=utf-8><base target="_blank">
   <style>html{background:#fff}</style>${row.html}`,
);

const shot = spawnSync(
  chrome,
  [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    "--screenshot=" + pngPath,
    "--window-size=900,1400",
    htmlPath,
  ],
  { stdio: "ignore" },
);

if (shot.status !== 0 || !existsSync(pngPath)) {
  rmSync(dir, { recursive: true, force: true });
  console.error("render failed");
  process.exit(1);
}

process.stdout.write("\x1b[2J\x1b[H");
// chafa auto-detects the terminal's best format; force tmux passthrough when
// inside tmux so kitty graphics reach Ghostty.
const chafaArgs = ["--clear", "--animate", "off", "--size", `${cols}x${rows - 2}`];
if (process.env.TMUX) chafaArgs.push("--passthrough", "tmux");
chafaArgs.push(pngPath);
spawnSync("chafa", chafaArgs, { stdio: "inherit" });

waitKey();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
