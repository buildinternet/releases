/**
 * Self-contained build for @releases/design-system. Emits a compiled dist/ the
 * design-sync converter (and, later, the web app) can consume:
 *   - dist/index.es.js   ESM bundle, React kept external (esbuild)
 *   - dist/index.d.ts +  per-component declarations (tsc, for prop contracts)
 *   - dist/styles.css    Tailwind v4 compiled tokens + utilities used by the lib
 *   - dist/fonts/*.woff2  self-hosted JetBrains Mono referenced by styles.css
 *
 * Run from the package root: `node build.mjs`.
 */
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const bin = (name) => join(root, "node_modules", ".bin", name);

/** Run a CLI to completion, surfacing its captured output (esp. on failure). */
async function run(cmd, args) {
  try {
    const { stdout } = await promisify(execFile)(cmd, args, { cwd: root });
    if (stdout) process.stdout.write(stdout);
  } catch (err) {
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    throw err;
  }
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. Fonts — copy exactly the JetBrains Mono weights styles.css references,
// derived from its @font-face `src` URLs so adding a weight to the CSS copies
// the matching woff2 too (the two lists can't silently drift apart).
console.log("[ds-build] copy fonts → dist/fonts/");
const css = readFileSync(join(root, "src/styles.css"), "utf8");
const fontFiles = [...css.matchAll(/url\("\.\/fonts\/([^"]+\.woff2)"\)/g)].map((m) => m[1]);
const fontSrcDir = join(root, "node_modules/@fontsource/jetbrains-mono/files");
mkdirSync(join(dist, "fonts"), { recursive: true });
for (const f of fontFiles) {
  const src = join(fontSrcDir, f);
  if (!existsSync(src)) {
    throw new Error(`[ds-build] missing font ${src} — is @fontsource/jetbrains-mono installed?`);
  }
  cpSync(src, join(dist, "fonts", f));
}

// 2. The three outputs are independent (distinct files, no shared inputs), so
// build them concurrently: JS bundle (esbuild, React external), Tailwind v4
// CSS, and per-component .d.ts (tsc, for prop contracts).
console.log("[ds-build] esbuild + tailwind + tsc (parallel)");
await Promise.all([
  build({
    entryPoints: [join(root, "src/index.ts")],
    outfile: join(dist, "index.es.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    external: ["react", "react-dom", "react/jsx-runtime"],
  }),
  run(bin("tailwindcss"), ["-i", "src/styles.css", "-o", "dist/styles.css", "--minify"]),
  run(bin("tsc"), ["--project", "tsconfig.json"]),
]);

console.log("[ds-build] done:", readdirSync(dist).join(", "));
