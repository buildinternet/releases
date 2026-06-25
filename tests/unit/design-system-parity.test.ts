/**
 * Parity guard: `@releases/design-system` ↔ the web app (issue #1765).
 *
 * `packages/design-system/src/classes.ts` and `src/styles.css` are deliberate
 * verbatim copies of the web app's design vocabulary:
 *   - classes.ts → web/src/components/account/ui.tsx  (exported class-string constants)
 *   - styles.css → web/src/app/globals.css            (brand `:root` tokens + `.org-surface` palette)
 *
 * Nothing imports across the two, so an app-side tweak to a button class or a
 * brand token silently desyncs the design system — and every design the
 * claude.ai/design agent produces from the package inherits the drift. This test
 * is the tripwire: it re-parses both sides and fails at PR time when a *shared*
 * value diverges.
 *
 * The web app is the source of truth; the package may hold curated extras (the
 * org-surface-only `orgEyebrowClass`, and `--font-jetbrains-mono`, which the web
 * app sets via next/font rather than an `@font-face`) — those are never flagged.
 *
 * Parsed as text on purpose: no module imports, so the guard has zero coupling to
 * the package's build, its React peer dep, or the web app's module graph.
 *
 * Throwaway by design: issue #1764 makes `web` consume this package instead of
 * copying it, at which point the duplication — and this guard — go away.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// tests/unit → repo root is two levels up.
const repoFile = (rel: string) => readFileSync(join(import.meta.dir, "..", "..", rel), "utf8");

const classesTs = repoFile("packages/design-system/src/classes.ts"); // package copy
const stylesCss = repoFile("packages/design-system/src/styles.css"); // package copy
const uiTsx = repoFile("web/src/components/account/ui.tsx"); // source of truth
const globalsCss = repoFile("web/src/app/globals.css"); // source of truth

const RESYNC_HINT =
  "Re-sync the design-system copy: update packages/design-system/src/{classes.ts,styles.css} " +
  "to match web/src/{components/account/ui.tsx,app/globals.css}, then run /design-sync. " +
  "(Issue #1764 removes this duplication and retires this guard.)";

// ── Class-string constants ──────────────────────────────────────────────────

/**
 * Parse `export const NAME = "…";` / `export const NAME = \`…\`;` into a
 * name→value map, resolving template-literal references to earlier constants
 * (e.g. `listCardClass = \`overflow-hidden ${cardClass}\``).
 */
function parseClassConstants(src: string): Map<string, string> {
  const raw = new Map<string, { value: string; template: boolean }>();
  const re = /export\s+const\s+(\w+)\s*=\s*(["`])((?:\\.|(?!\2)[\s\S])*)\2\s*;/g;
  for (const m of src.matchAll(re)) {
    raw.set(m[1], { value: m[3], template: m[2] === "`" });
  }

  const resolved = new Map<string, string>();
  const resolve = (name: string, seen: Set<string>): string => {
    const cached = resolved.get(name);
    if (cached !== undefined) return cached;
    const entry = raw.get(name);
    if (!entry) throw new Error(`class constant referenced but not found: ${name}`);
    if (seen.has(name)) throw new Error(`circular template reference at ${name}`);
    seen.add(name);
    const value = entry.template
      ? entry.value.replace(/\$\{(\w+)\}/g, (_full, ref: string) => resolve(ref, seen))
      : entry.value;
    resolved.set(name, value);
    return value;
  };

  for (const name of raw.keys()) resolve(name, new Set());
  return resolved;
}

describe("class-string constants stay in sync with web/account/ui.tsx", () => {
  const appConstants = parseClassConstants(uiTsx);
  const pkgConstants = parseClassConstants(classesTs);

  test("the parser found the expected vocabulary (guards against a silent regex break)", () => {
    expect(appConstants.size).toBeGreaterThanOrEqual(13);
    expect(appConstants.has("primaryButtonClass")).toBe(true);
    expect(pkgConstants.has("primaryButtonClass")).toBe(true);
  });

  test("every web class constant is mirrored verbatim in the package", () => {
    const drift: string[] = [];
    for (const [name, appValue] of appConstants) {
      const pkgValue = pkgConstants.get(name);
      if (pkgValue === undefined) {
        drift.push(`• \`${name}\` exists in web ui.tsx but is MISSING from package classes.ts`);
      } else if (pkgValue !== appValue) {
        drift.push(`• \`${name}\` differs:\n    web:     ${appValue}\n    package: ${pkgValue}`);
      }
    }
    if (drift.length > 0) {
      throw new Error(
        `Design-system class constants drifted from the web app:\n${drift.join("\n")}\n\n${RESYNC_HINT}`,
      );
    }
  });
});

// ── Brand + surface tokens ──────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Extract `--prop: value;` declarations from a single top-level selector block. */
function declsForSelector(css: string, selector: string): Map<string, string> {
  const re = new RegExp(`(?:^|\\n)${escapeRe(selector)}\\s*\\{([^}]*)\\}`);
  const m = re.exec(css);
  const out = new Map<string, string>();
  if (!m) return out;
  // Strip comments before splitting on `;` — a `/* … */` note can itself contain
  // a semicolon (the `:root` brand comment does), which would otherwise shred the
  // declaration that follows it.
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, "");
  for (const part of body.split(";")) {
    const decl = part.trim();
    if (!decl.startsWith("--")) continue;
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    out.set(
      decl.slice(0, colon).trim(),
      decl
        .slice(colon + 1)
        .trim()
        .replace(/\s+/g, " "),
    );
  }
  return out;
}

// The one token the package legitimately declares but the web app does not: the
// web app ships JetBrains Mono via next/font, so it never sets this variable.
const PACKAGE_ONLY_ROOT_TOKEN = "--font-jetbrains-mono";

// The selector blocks the package mirrors from globals.css. The app's globals.css
// carries much more (prose, animations, view transitions, …) that the package
// does not replicate — so the check runs package → app (every token the package
// mirrors must match the app), not the other way round.
const MIRRORED_SELECTORS = [":root", ".dark", ".org-surface", ".dark .org-surface"];

describe("brand + surface tokens stay in sync with web/app/globals.css", () => {
  test("the package's :root brand block was actually parsed (guards against a silent break)", () => {
    expect(declsForSelector(stylesCss, ":root").get("--accent")).toBeDefined();
    expect(declsForSelector(globalsCss, ":root").get("--accent")).toBeDefined();
  });

  test("every token the package mirrors matches the web app", () => {
    const drift: string[] = [];
    for (const selector of MIRRORED_SELECTORS) {
      const pkg = declsForSelector(stylesCss, selector);
      const app = declsForSelector(globalsCss, selector);
      for (const [prop, pkgValue] of pkg) {
        if (selector === ":root" && prop === PACKAGE_ONLY_ROOT_TOKEN) continue;
        const appValue = app.get(prop);
        if (appValue === undefined) {
          drift.push(
            `• \`${selector} { ${prop} }\` is in package styles.css but MISSING from web globals.css`,
          );
        } else if (appValue !== pkgValue) {
          drift.push(
            `• \`${selector} { ${prop} }\` differs:\n    web:     ${appValue}\n    package: ${pkgValue}`,
          );
        }
      }
    }
    if (drift.length > 0) {
      throw new Error(
        `Design-system tokens drifted from the web app:\n${drift.join("\n")}\n\n${RESYNC_HINT}`,
      );
    }
  });
});
