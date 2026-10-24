/**
 * npm `prepack` / `postpack` hook for the published library packages
 * (`packages/core`, `packages/api-types`, `packages/sdk`).
 *
 * In the monorepo, their `exports` point at TypeScript source so Bun, the
 * workers and Next consume them without a build step. npm consumers need
 * JavaScript, so on pack this script builds `dist/` (tsc), adds the `.js`
 * extensions Node's ESM loader needs to relative imports, and swaps
 * the manifest's `exports` and `files` to it (and pins `workspace:` ranges);
 * `postpack` restores the source manifest. Run from the package directory:
 *
 *   bun ../../scripts/pack-dist.ts prepack [dep-dir…]
 *   bun ../../scripts/pack-dist.ts postpack
 *
 * `dep-dir`s are workspace packages whose `dist/` this build resolves types
 * from (see `paths` in api-types' tsconfig.build.json); they build first.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { logger } from "@buildinternet/releases-lib/logger";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const MANIFEST = "package.json";
const BACKUP = "package.json.src";

type Manifest = {
  name?: string;
  version?: string;
  exports: Record<string, string>;
  files?: string[];
  dependencies?: Record<string, string>;
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

/**
 * npm doesn't understand `workspace:` ranges. Pin them the way pnpm and bun do
 * on publish: `workspace:*` → the exact version, `workspace:^` / `workspace:~`
 * → that prefix plus the version.
 */
export function pinWorkspaceDeps(
  deps: Record<string, string> | undefined,
  versions: Record<string, string>,
): Record<string, string> | undefined {
  if (!deps) return deps;
  return Object.fromEntries(
    Object.entries(deps).map(([name, range]) => {
      if (!range.startsWith("workspace:")) return [name, range];
      const version = versions[name];
      if (!version) throw new Error(`${name} is a workspace dependency with no known version`);
      const spec = range.slice("workspace:".length);
      return [name, spec === "*" ? version : spec === "^" || spec === "~" ? spec + version : spec];
    }),
  );
}

/** The manifest npm should publish: dist exports, `dist` instead of `src`, pinned workspace deps. */
export function distManifest(manifest: Manifest, versions: Record<string, string> = {}): Manifest {
  return {
    ...manifest,
    exports: distExports(manifest.exports) as Manifest["exports"],
    files: (manifest.files ?? []).map((f) => (f === "src" ? "dist" : f)),
    dependencies: pinWorkspaceDeps(manifest.dependencies, versions),
  };
}

/** Name → version for every package under `packages/`. */
function workspaceVersions(): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const dir of readdirSync("..")) {
    const file = `../${dir}/package.json`;
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8")) as Manifest;
    if (pkg.name && pkg.version) versions[pkg.name] = pkg.version;
  }
  return versions;
}

const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\2/g;

/**
 * Give extensionless relative specifiers the extension Node's ESM loader
 * requires. The source stays extensionless because Next's Turbopack won't map
 * `./x.js` to `./x.ts` inside `packages/core`; `exists` checks a candidate
 * path relative to the importing file.
 */
export function addJsExtensions(code: string, exists: (relative: string) => boolean): string {
  return code.replace(RELATIVE_SPECIFIER, (match, lead: string, quote: string, spec: string) => {
    if (/\.(?:c|m)?js$|\.json$/.test(spec)) return match;
    if (exists(`${spec}.js`)) return `${lead}${quote}${spec}.js${quote}`;
    if (exists(`${spec}/index.js`)) return `${lead}${quote}${spec}/index.js${quote}`;
    return match;
  });
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((f) => join(dir, f));
}

function build(dir: string) {
  const dist = join(dir, "dist");
  rmSync(dist, { recursive: true, force: true });
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: dir, stdio: "inherit" });
  for (const file of filesUnder(dist)) {
    if (!file.endsWith(".js") && !file.endsWith(".d.ts")) continue;
    const code = readFileSync(file, "utf8");
    const fixed = addJsExtensions(code, (rel) => existsSync(join(dirname(file), rel)));
    if (fixed !== code) writeFileSync(file, fixed);
  }
}

function prepack(depDirs: string[]) {
  if (existsSync(BACKUP)) throw new Error(`${BACKUP} exists; a previous pack did not finish`);
  for (const dir of depDirs) build(dir);
  build(".");
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  copyFileSync(MANIFEST, BACKUP);
  const published = distManifest(manifest, workspaceVersions());
  writeFileSync(MANIFEST, `${JSON.stringify(published, null, 2)}\n`);
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
