/**
 * npm `prepack` / `postpack` hook for the published library packages
 * (`packages/core`, `packages/api-types`).
 *
 * In the monorepo, their `exports` point at TypeScript source so Bun, the
 * workers and Next consume them without a build step. npm consumers need
 * JavaScript, so on pack this script builds `dist/` (tsc, NodeNext) and swaps
 * the manifest's `exports` and `files` to it; `postpack` restores the source
 * manifest. Run from the package directory:
 *
 *   bun ../../scripts/pack-dist.ts prepack [dep-dir…]
 *   bun ../../scripts/pack-dist.ts postpack
 *
 * `dep-dir`s are workspace packages whose `dist/` this build resolves types
 * from (see `paths` in api-types' tsconfig.build.json); they build first.
 */
import { execFileSync } from "node:child_process";
import { logger } from "@buildinternet/releases-lib/logger";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const MANIFEST = "package.json";
const BACKUP = "package.json.src";

type Manifest = {
  exports: Record<string, string>;
  files?: string[];
  [key: string]: unknown;
};

/** `./src/foo.ts` → `{ types: ./dist/foo.d.ts, default: ./dist/foo.js }`. */
export function distExports(exports: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(exports).map(([subpath, target]) => {
      const match = /^\.\/src\/(.+)\.ts$/.exec(target);
      if (!match) throw new Error(`export ${subpath} → ${target} is not a ./src/*.ts path`);
      return [subpath, { types: `./dist/${match[1]}.d.ts`, default: `./dist/${match[1]}.js` }];
    }),
  );
}

/** The manifest npm should publish: dist exports, and `dist` instead of `src` in `files`. */
export function distManifest(manifest: Manifest): Manifest {
  return {
    ...manifest,
    exports: distExports(manifest.exports) as Manifest["exports"],
    files: (manifest.files ?? []).map((f) => (f === "src" ? "dist" : f)),
  };
}

function build(dir: string) {
  rmSync(`${dir}/dist`, { recursive: true, force: true });
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: dir, stdio: "inherit" });
}

function prepack(depDirs: string[]) {
  if (existsSync(BACKUP)) throw new Error(`${BACKUP} exists; a previous pack did not finish`);
  for (const dir of depDirs) build(dir);
  build(".");
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  copyFileSync(MANIFEST, BACKUP);
  writeFileSync(MANIFEST, `${JSON.stringify(distManifest(manifest), null, 2)}\n`);
}

function postpack() {
  if (existsSync(BACKUP)) renameSync(BACKUP, MANIFEST);
}

if (import.meta.main) {
  const step = process.argv[2];
  if (step === "prepack") prepack(process.argv.slice(3));
  else if (step === "postpack") postpack();
  else {
    logger.error("usage: pack-dist.ts prepack [dep-dir…] | postpack");
    process.exit(1);
  }
}
