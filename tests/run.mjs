import esbuild from "esbuild";
import { readdirSync, rmSync } from "fs";
import { spawnSync } from "child_process";

const out = ".test-build";
rmSync(out, { recursive: true, force: true });

const tests = readdirSync("tests").filter((f) => f.endsWith(".test.ts"));
await esbuild.build({
  entryPoints: tests.map((f) => `tests/${f}`),
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: out,
  outExtension: { ".js": ".mjs" },
  alias: { obsidian: "./tests/obsidian-stub.ts" },
  logLevel: "warning",
});

const files = tests.map((f) => `${out}/${f.replace(/\.ts$/, ".mjs")}`);
const run = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(run.status ?? 1);
