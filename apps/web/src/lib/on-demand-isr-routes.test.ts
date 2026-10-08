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
  "app/collections/[slug]/page.tsx",
  "app/collections/[slug]/digest/page.tsx",
  "app/collections/[slug]/digest/[week]/page.tsx",
  "app/collections/[slug]/digest/[week]/replay/page.tsx",
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
