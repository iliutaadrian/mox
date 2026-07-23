// Compile a standalone `spark` binary. The Solid transform must run at BUILD
// time (via the bun-plugin) — the bunfig `preload` only covers `bun run`, and a
// compiled binary that defers to it fails at launch with "preload not found".
import solidPlugin from "@opentui/solid/bun-plugin";

const out = process.argv[2] ?? "dist/spark";

const result = await Bun.build({
  entrypoints: ["src/index.tsx"],
  target: "bun",
  plugins: [solidPlugin],
  minify: true,
  compile: { outfile: out },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`compiled ${out}`);
