// Compile a standalone `mox` binary. The Solid transform must run at BUILD
// time (via the bun-plugin) — the bunfig `preload` only covers `bun run`, and a
// compiled binary that defers to it fails at launch with "preload not found".
//
//   bun run scripts/build.ts                                  → dist/mox (host)
//   bun run scripts/build.ts dist/mox-darwin-arm64 bun-darwin-arm64
//   bun run scripts/build.ts dist/mox-darwin-x64   bun-darwin-x64
import solidPlugin from "@opentui/solid/bun-plugin";

const out = process.argv[2] ?? "dist/mox";
const target = process.argv[3]; // e.g. bun-darwin-arm64 — omit to build for the host

const result = await Bun.build({
  entrypoints: ["src/index.tsx"],
  target: "bun",
  plugins: [solidPlugin],
  minify: true,
  compile: target ? { outfile: out, target: target as `bun-${string}` } : { outfile: out },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`compiled ${out}${target ? ` (${target})` : ""}`);
