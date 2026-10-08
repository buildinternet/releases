import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/**
 * Public dynamic-segment routes that must be on-demand ISR. A dynamic route
 * renders on every request unless it exports BOTH `revalidate` and
 * `generateStaticParams` (see `lib/static-params.ts`), and an uncached public
 * page turns every crawler sweep into one full render per URL — slow first
 * bytes and render-count billing (#1607, #2461). Add new public dynamic pages
 * here.
 */
const ISR_ROUTES = [
  "app/[orgSlug]/[slug]/page.tsx",
  "app/[orgSlug]/[slug]/highlights/page.tsx",
  "app/[orgSlug]/[slug]/changelog/page.tsx",
  "app/collections/[slug]/page.tsx",
  "app/collections/[slug]/digest/page.tsx",
  "app/collections/[slug]/digest/[week]/page.tsx",
  "app/updates/[date]/page.tsx",
];

const SRC = path.join(import.meta.dir, "..");

describe("on-demand ISR routes", () => {
  for (const route of ISR_ROUTES) {
    it(`${route} exports revalidate and generateStaticParams`, () => {
      const source = fs.readFileSync(path.join(SRC, route), "utf8");
      expect(source).toMatch(/^export const revalidate = \d+;$/m);
      expect(source).toMatch(/^export const generateStaticParams = enableOnDemandIsr;$/m);
      // A dynamic API in the page would force per-request rendering anyway.
      expect(source).not.toMatch(/\bsearchParams\b|\bcookies\(\)|\bheaders\(\)/);
    });
  }
});

/**
 * `opengraph-image.tsx` under a dynamic segment is its own route and does NOT
 * inherit the sibling page's `generateStaticParams`, so without one it renders
 * on every request (prod showed `x-vercel-cache: MISS` on every hit, #2461).
 * Walks the tree so a new card can't skip it.
 */
function dynamicOgImageRoutes(dir: string, underDynamic = false): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...dynamicOgImageRoutes(full, underDynamic || entry.name.startsWith("[")));
    } else if (underDynamic && entry.name === "opengraph-image.tsx") {
      found.push(path.relative(SRC, full));
    }
  }
  return found;
}

describe("dynamic-segment OG image routes", () => {
  const routes = dynamicOgImageRoutes(path.join(SRC, "app"));

  it("finds the OG image routes", () => {
    expect(routes).toContain("app/[orgSlug]/[slug]/opengraph-image.tsx");
  });

  for (const route of routes) {
    it(`${route} exports revalidate and generateStaticParams`, () => {
      const source = fs.readFileSync(path.join(SRC, route), "utf8");
      expect(source).toMatch(/^export const revalidate = \d+;$/m);
      expect(source).toMatch(/^export const generateStaticParams = enableOnDemandIsr;$/m);
    });
  }
});
