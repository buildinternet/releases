/**
 * mockModule — a thin, safety-checked wrapper around Bun's `mock.module`.
 *
 * Bun's `mock.module` is process-global: once a module is mocked, the
 * replacement persists across every test file in the same `bun test` run.
 * If a factory omits an export that another file expects, that file crashes
 * with `SyntaxError: Export named 'X' not found in module …` — often with no
 * indication of which mock is at fault (see buildinternet/releases#615).
 *
 * This helper:
 *  1. Resolves the module specifier to an absolute filesystem path.
 *  2. Reads the source file and extracts value-level export names via static
 *     analysis (regex over the TypeScript/JS source). This avoids loading the
 *     real module into the process — which would prevent mock.module from
 *     overriding it for subsequently-imported files.
 *  3. Calls the factory to capture its keys.
 *  4. Asserts that every extracted export key is present in the factory object —
 *     failing fast with a message that names the missing exports.
 *  5. Calls through to `mock.module` with the resolved absolute path so the
 *     mock applies correctly regardless of where this helper file lives.
 *
 * The `default` export is excluded from the comparison when it appears on only
 * one side — this avoids false positives from TS/CJS interop re-exports.
 *
 * Usage (in a test file):
 *
 *   import { mockModule } from "../../tests/mock-module.js";
 *
 *   await mockModule(
 *     "../src/webhooks/queries.js",
 *     () => ({ insertWebhookSubscription: ..., ... }),
 *     import.meta.url,   // ← lets the helper resolve the path correctly
 *   );
 *
 * Pass `import.meta.url` as the third argument whenever the path is relative.
 * For bare specifiers (e.g. `"cloudflare:workers"`, `"@scope/pkg"`) the third
 * argument is still accepted but the specifier is passed as-is to Bun.resolveSync.
 *
 * If the source file cannot be read or resolved (e.g. a built-in or
 * Cloudflare-runtime-only specifier), the completeness check is skipped and
 * `mock.module` is still called so the test proceeds normally.
 */

import { mock } from "bun:test";
import { fileURLToPath } from "url";
import { dirname } from "path";

type Factory = () => Record<string, unknown>;

/**
 * Extract value-level export names from TypeScript/JavaScript source text.
 *
 * Handles:
 *   export function foo(...)            → "foo"
 *   export async function foo(...)      → "foo"
 *   export class Foo                    → "Foo"
 *   export const / let / var foo        → "foo"
 *   export { foo, bar as baz }          → "foo", "baz"
 *   export { type Foo, foo }            → "foo" (type-only entries skipped)
 *   export default ...                  → "default"
 *
 * Intentionally excluded (type-only, no runtime binding):
 *   export type Foo = ...
 *   export interface Foo { ... }
 *   export type { Foo }
 */
function extractValueExports(source: string): Set<string> {
  const names = new Set<string>();

  // export [async] function|class|const|let|var Name
  for (const m of source.matchAll(
    /^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/gm,
  )) {
    names.add(m[1]);
  }

  // export default (anything)
  if (/^export\s+default\b/m.test(source)) {
    names.add("default");
  }

  // export { foo, bar as baz, type Qux } [from '...']
  // We parse the brace block and skip entries that start with "type ".
  for (const m of source.matchAll(/^export\s*\{([^}]+)\}(?:\s*from\s*['"][^'"]+['"])?/gm)) {
    for (const entry of m[1].split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      // Skip type-only re-exports: "type Foo" or "type Foo as Bar"
      if (/^type\s/.test(trimmed)) continue;
      // The export name is the last word (after optional "originalName as")
      const exportName = trimmed
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (exportName && /^\w+$/.test(exportName)) {
        names.add(exportName);
      }
    }
  }

  return names;
}

/**
 * Attempt to resolve a module specifier to an absolute filesystem path.
 * Returns null when the specifier cannot be resolved (built-ins, CF-only, etc.).
 */
function tryResolve(specifier: string, fromFile: string): string | null {
  try {
    return Bun.resolveSync(specifier, fromFile);
  } catch {
    return null;
  }
}

export async function mockModule(
  path: string,
  factory: Factory,
  callerUrl?: string,
): Promise<ReturnType<typeof mock.module>> {
  // Determine the directory from which we resolve the specifier.
  // Bun.resolveSync expects a directory (not a file path) as the second arg.
  // When callerUrl is a file:// URL pointing to the test file, we take its dirname.
  let fromDir: string;
  if (callerUrl) {
    const callerPath = callerUrl.startsWith("file://") ? fileURLToPath(callerUrl) : callerUrl;
    fromDir = dirname(callerPath);
  } else {
    fromDir = process.cwd();
  }

  // Resolve the specifier to an absolute filesystem path.
  const resolvedPath = tryResolve(path, fromDir);

  // Capture the factory's keys up front.
  const factoryResult = factory();
  const factoryKeys = new Set(Object.keys(factoryResult));

  if (resolvedPath === null) {
    // Specifier is un-resolvable in this environment (e.g. cloudflare:workers).
    // Skip the completeness check and call mock.module with the original path.
    return mock.module(path, factory);
  }

  // Read the source file and extract value-level exports via static analysis.
  // This avoids importing the module into the process (which would prevent
  // mock.module from overriding the module registry entry).
  let realKeys: Set<string>;
  try {
    const source = await Bun.file(resolvedPath).text();
    realKeys = extractValueExports(source);
  } catch {
    // File unreadable — skip check, proceed with mock.
    return mock.module(resolvedPath, factory);
  }

  // Skip comparison when static analysis found nothing (empty/re-export-only files).
  if (realKeys.size === 0) {
    return mock.module(resolvedPath, factory);
  }

  // Exclude `default` when it's present on only one side — TS/CJS interop quirk.
  const onlyInReal = !factoryKeys.has("default") && realKeys.has("default");
  const effectiveRealKeys = new Set([...realKeys].filter((k) => !(k === "default" && onlyInReal)));

  const missing = [...effectiveRealKeys].filter((k) => !factoryKeys.has(k));

  if (missing.length > 0) {
    throw new Error(
      `mockModule("${path}"): factory is missing ${missing.length} export(s) that the real module provides.\n` +
        `Missing: ${missing.map((k) => JSON.stringify(k)).join(", ")}\n` +
        `Add stub implementations for these exports to prevent downstream test files from ` +
        `crashing with "Export named '…' not found".`,
    );
  }

  // Pass the absolute path to mock.module so the mock is registered against
  // the correct module identity regardless of where this helper file lives.
  return mock.module(resolvedPath, factory);
}
