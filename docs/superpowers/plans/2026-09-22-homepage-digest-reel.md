# Homepage digest reel + collection digest prominence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the weekly collection digests on the homepage as a full-width reel, make the latest digest the lead of every collection page (plus inline week-boundary cards in the feed), and bring digest release links in line with the upstream-first link policy.

**Architecture:** A pure parser in `@releases/rendering` splits a digest body into sections (heading, anchor, lede, cited release ids) and rewrites `/release/` links to upstream URLs. The API resolves each cited release's upstream `url`, product, and org avatar, and exposes sections on the REST digest detail plus a new GraphQL root field `latestWeeklyDigests` for the homepage. Web renders a reel on the homepage, a hero + inline digest cards on the collection page, and upstream links on the digest page.

**Tech Stack:** Bun, TypeScript, Hono + zod-openapi (REST), Pothos + GraphQL Yoga persisted operations (GraphQL), Drizzle/D1, Next.js 16 App Router, Tailwind v4, unified/remark/rehype.

**Spec:** Design canvas "Homepage Digest Reel" (claude.ai artifact, **Chosen** page): `Main.dc.html` (homepage reel), `Home-Mobile.dc.html` (phone), `Collection-Hero.dc.html` (collection page). The **Explored** page holds rejected directions — do not build those.

## Global Constraints

- No feature flag. Ship enabled (AGENTS.md: "Default to shipping a feature enabled, with no flag").
- Release links follow `web/src/lib/release-link.ts` → `releaseLinkTarget()`: upstream `url` first (new tab, `rel={EXTERNAL_UGC_REL}`), `/release/<id>` only as fallback. Never make `/release/<id>` the primary link for a release.
- Every HTML link that stands for a release carries `data-release-id="rel_…"`, upstream or fallback. Use `releaseLinkProps()` (Task 0), which spreads `href`, `target`, `rel`, and the data attribute together. Markdown, Atom, and JSON-LD outputs can't carry attributes and are exempt.
- Digest **section** rows are internal links to `/collections/<slug>/digest/<weekStart>#<anchor>` (same tab, no ↗). Only upstream release links get the ↗ glyph.
- `packages/api-types` changes are additive only, and need a changeset: `bun run changeset` (bump `@buildinternet/releases-api-types` minor).
- D1: `inArray` lookups chunk at 90 ids (`IN_LOOKUP_CHUNK` already in `workers/api/src/queries/collection-summaries.ts`).
- Worker logging via `logEvent()` from `@releases/lib/log-event` only.
- Avatars: use `OrgAvatar` (`web/src/components/org-avatar.tsx`); products show their org's avatar, labelled with the product name. No emoji, no new chip rows.
- Collection page uses `.org-surface` tokens (`var(--surface)`, `var(--fg-2)`, `var(--line)`, `var(--accent)` …); homepage uses stone Tailwind utilities with `dark:` variants.
- Keep the repo PII-free (no home-dir paths, no personal emails) in code, tests, and this doc.
- Before pushing: `bun run check`, `bun test` (root script runs `workers/api` in its own process), `bun run --cwd web codegen` output committed.

## File Structure

| File | Responsibility |
|---|---|
| `packages/rendering/src/digest-sections.ts` (new) | Pure: `digestSectionAnchor`, `parseDigestSections`, `rewriteDigestReleaseLinks` |
| `packages/rendering/src/digest-sections.test.ts` (new) | Unit tests for the above |
| `packages/rendering/package.json` | Add `./digest-sections` export |
| `packages/api-types/src/schemas/collections.ts` | Extend `DigestCoveredReleaseSchema`; add `DigestSectionSchema`; `sections` on detail |
| `packages/api-types/src/api-types.ts` | Re-export `DigestSectionSchema` / `DigestSection` type |
| `.changeset/*.md` (new) | api-types minor bump |
| `workers/api/src/queries/collection-summaries.ts` | Resolver returns `url`, `product`, org avatar; new `listLatestWeeklyDigests` |
| `workers/api/src/queries/collection-summaries.test.ts` | Tests for both |
| `workers/api/src/routes/collections.ts` | Detail route adds `sections` |
| `workers/api/src/graphql/builder.ts`, `types/collection.ts`, `schema.ts` | `WeeklyDigestPreview` types + `latestWeeklyDigests` root field |
| `workers/api/test/graphql.test.ts` | Root field test |
| `packages/api-types/graphql/schema.graphql` | Regenerated snapshot |
| `web/src/lib/graphql/operations/homepage-digests.graphql` (new) + `__generated__/*` | Persisted op |
| `web/src/lib/digest-reel.ts` (new) + test | Pure: `splitDigestReel`, `sectionProducts` |
| `web/src/components/digest-reel.tsx` (new) | Client reel: cards, arrows, hover card, "Also this week" |
| `web/src/app/page.tsx` | Fetch + render the band between Featured table and `AgentUseCases` |
| `web/src/components/latest-digest-hero.tsx` (new) | Collection-page hero + "Earlier" strip |
| `web/src/app/collections/[slug]/page.tsx` | Swap "This week:" link for the hero; pass digests to timeline |
| `web/src/components/collection-context-rail.tsx` | Drop the "Weekly digests" box |
| `web/src/components/collection-timeline.tsx` | Week dividers + inline digest cards |
| `web/src/lib/render-release-body.ts` + `render-digest-body.test.ts` | `headingIds` option |
| `web/src/app/collections/[slug]/digest/[week]/page.tsx` | Upstream links in body + covered list; heading anchors |

---

### Task 0: `releaseLinkProps()` — one helper for release anchors, stamping `data-release-id`

**Files:**
- Modify: `web/src/lib/release-link.ts`, `web/src/lib/release-link.test.ts`
- Modify (adopt the helper): `web/src/components/shipping-now-ticker.tsx`, `web/src/components/release-item.tsx`, `web/src/components/release-title-link.tsx`, `web/src/app/following/following-client.tsx`, `web/src/app/live/live-stream.tsx`: every current `releaseLinkTarget(` caller that renders an anchor

**Interfaces:**
- Produces:
  - `type ReleaseLinkProps = { href: string; target?: "_blank"; rel?: string; "data-release-id"?: string }`
  - `releaseLinkProps(release: ReleaseLinkInput): ReleaseLinkProps | null`, the same fallback order as `releaseLinkTarget`. Spread it onto an `<a>` (or onto `next/link` when not external).
  - `isExternalReleaseLink(p: ReleaseLinkProps): boolean` (`p.target === "_blank"`)

- [ ] **Step 1: Failing tests** (append to `release-link.test.ts`)

```ts
import { releaseLinkProps } from "./release-link";

describe("releaseLinkProps", () => {
  test("upstream link: new tab, UGC rel, data-release-id", () => {
    expect(releaseLinkProps({ id: "rel_a", url: "https://example.com/x" })).toEqual({
      href: "https://example.com/x",
      target: "_blank",
      rel: EXTERNAL_UGC_REL,
      "data-release-id": "rel_a",
    });
  });
  test("fallback link: internal path, still tagged", () => {
    expect(releaseLinkProps({ id: "rel_b", url: null })).toEqual({
      href: "/release/rel_b",
      "data-release-id": "rel_b",
    });
  });
  test("no id and no url → null", () => {
    expect(releaseLinkProps({ id: null, url: null })).toBeNull();
  });
  test("upstream link without an id omits the attribute", () => {
    expect(releaseLinkProps({ url: "https://example.com/y" })).toEqual({
      href: "https://example.com/y", target: "_blank", rel: EXTERNAL_UGC_REL,
    });
  });
});
```

Import `EXTERNAL_UGC_REL` from `./sanitize`. Run `bun test web/src/lib/release-link.test.ts` → FAIL.

- [ ] **Step 2: Implement** (in `release-link.ts`, below `releaseLinkTarget`)

```ts
import { EXTERNAL_UGC_REL } from "./sanitize";

/** Anchor props for a release link: {@link releaseLinkTarget}'s destination plus
 *  `data-release-id`, so an upstream link still records which registry release
 *  it stands for (analytics, scrapers, our own scripts). The data attribute is
 *  inert for navigation and SEO. */
export type ReleaseLinkProps = {
  href: string;
  target?: "_blank";
  rel?: string;
  "data-release-id"?: string;
};

export function releaseLinkProps(release: ReleaseLinkInput): ReleaseLinkProps | null {
  const link = releaseLinkTarget(release);
  if (!link) return null;
  return {
    href: link.href,
    ...(link.external ? { target: "_blank" as const, rel: EXTERNAL_UGC_REL } : {}),
    ...(release.id ? { "data-release-id": release.id } : {}),
  };
}

export const isExternalReleaseLink = (p: ReleaseLinkProps) => p.target === "_blank";
```

If `sanitize.ts` imports from `release-link.ts`, move the constant import to avoid a cycle. Run → PASS.

- [ ] **Step 3: Adopt in existing callers.** In each file listed above, replace the `releaseLinkTarget(...)` + hand-spread `target`/`rel` with `const linkProps = releaseLinkProps(release)` and `{...linkProps}` on the anchor. Keep each component's existing fallback when `null`. Leave the render structure alone. Where a component uses `next/link` for the internal case, keep doing so (`isExternalReleaseLink(linkProps) ? <a {...linkProps}> : <Link {...linkProps}>`). Update or extend any existing render tests (`shipping-now-ticker.test.tsx`, etc.) to assert `data-release-id` is present.

- [ ] **Step 4: Run** `bun test web/` → PASS. `bun run lint`.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/release-link.ts web/src/lib/release-link.test.ts web/src/components web/src/app/following web/src/app/live
git commit -m "feat(web): releaseLinkProps stamps data-release-id on release links"
```

---

### Task 1: Digest section parser + link rewriter (`@releases/rendering/digest-sections`)

**Files:**
- Create: `packages/rendering/src/digest-sections.ts`
- Create: `packages/rendering/src/digest-sections.test.ts`
- Modify: `packages/rendering/package.json` (exports)

**Interfaces:**
- Produces:
  - `digestSectionAnchor(heading: string): string`
  - `interface ParsedDigestSection { heading: string; anchor: string; lede: string; releaseIds: string[] }`
  - `parseDigestSections(body: string): ParsedDigestSection[]`
  - `rewriteDigestReleaseLinks(body: string, urlById: ReadonlyMap<string, string | null | undefined>): string` (markdown outputs only; web HTML rewrites in rehype so it can stamp `data-release-id`, see Task 8)
  - `releaseIdFromPath(href: string): string | null`: the `rel_…` id from a `/release/rel_<id>[-slug]` path, else null

Context: digest bodies are markdown with `### Heading` sections. Cited releases appear as markdown links to `/release/rel_<21 chars>[-slug]` (the generator in `packages/ai/src/collection-weekly-digest.ts` resolves placeholders to these paths). Release ids are `rel_` + 21 nanoid chars from `[A-Za-z0-9_-]`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/rendering/src/digest-sections.test.ts
import { describe, expect, test } from "bun:test";
import {
  digestSectionAnchor,
  parseDigestSections,
  rewriteDigestReleaseLinks,
  releaseIdFromPath,
} from "./digest-sections";

const A = "rel_JotzQfuFf_u8NV4btlouH";
const B = "rel_ACOkQGJzq0IqqkhoWRR7C";
const C = "rel_1SjjEYFg34YFzPatqXk3o";

const BODY = `Intro paragraph that is not a section.

### Agents learn to talk

The week's most visible shift is that coding agents started speaking. [Codex CLI 0.155.0](/release/${A}-voice-conversations) added \`/voice\`, and [Devin](/release/${B}) shipped voice mode. Later [Codex again](/release/${A}-voice-conversations).

Second paragraph is ignored for the lede.

### Claude Code's week: hardening the edges

**Claude Code** closed gaps. See [v2.1.275](/release/${C}-memory-file).
`;

describe("digestSectionAnchor", () => {
  test("slugifies headings deterministically", () => {
    expect(digestSectionAnchor("Agents learn to talk")).toBe("agents-learn-to-talk");
    expect(digestSectionAnchor("Claude Code's week: hardening the edges")).toBe(
      "claude-codes-week-hardening-the-edges",
    );
    expect(digestSectionAnchor("Codex goes multimodal, OpenAI’s SDKs")).toBe(
      "codex-goes-multimodal-openais-sdks",
    );
  });
});

describe("parseDigestSections", () => {
  test("splits on ### headings, ignoring the preamble", () => {
    const sections = parseDigestSections(BODY);
    expect(sections.map((s) => s.heading)).toEqual([
      "Agents learn to talk",
      "Claude Code's week: hardening the edges",
    ]);
    expect(sections[0].anchor).toBe("agents-learn-to-talk");
  });

  test("collects unique cited release ids in first-seen order", () => {
    const [first, second] = parseDigestSections(BODY);
    expect(first.releaseIds).toEqual([A, B]);
    expect(second.releaseIds).toEqual([C]);
  });

  test("lede is the first sentence of the first paragraph, markdown stripped", () => {
    const [first, second] = parseDigestSections(BODY);
    expect(first.lede).toBe("The week's most visible shift is that coding agents started speaking.");
    expect(second.lede).toBe("Claude Code closed gaps.");
  });

  test("body with no ### headings yields no sections", () => {
    expect(parseDigestSections("Just prose.")).toEqual([]);
  });
});

describe("releaseIdFromPath", () => {
  test("extracts the id from slugged and bare release paths", () => {
    expect(releaseIdFromPath(`/release/${A}-voice-conversations`)).toBe(A);
    expect(releaseIdFromPath(`/release/${B}`)).toBe(B);
    expect(releaseIdFromPath("https://example.com/release/x")).toBeNull();
    expect(releaseIdFromPath("/collections/x")).toBeNull();
  });
});

describe("rewriteDigestReleaseLinks", () => {
  test("swaps /release/ links for upstream urls when known", () => {
    const urls = new Map<string, string | null>([
      [A, "https://developers.openai.com/codex/changelog/#0-155-0"],
      [B, null],
    ]);
    const out = rewriteDigestReleaseLinks(BODY, urls);
    expect(out).toContain("[Codex CLI 0.155.0](https://developers.openai.com/codex/changelog/#0-155-0)");
    expect(out).toContain("[Codex again](https://developers.openai.com/codex/changelog/#0-155-0)");
    // No upstream url → keep the internal fallback.
    expect(out).toContain(`[Devin](/release/${B})`);
    // Unknown id → untouched.
    expect(out).toContain(`[v2.1.275](/release/${C}-memory-file)`);
  });

  test("ignores non-http upstream urls", () => {
    const out = rewriteDigestReleaseLinks(`[x](/release/${A})`, new Map([[A, "javascript:alert(1)"]]));
    expect(out).toBe(`[x](/release/${A})`);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/rendering/src/digest-sections.test.ts`
Expected: FAIL — `Cannot find module './digest-sections'`.

- [ ] **Step 3: Implement**

```ts
// packages/rendering/src/digest-sections.ts
/**
 * Pure helpers over a weekly-digest markdown body (`### Heading` sections whose
 * cited releases are markdown links to `/release/rel_<id>[-slug]`). Shared by
 * the API (wire `sections`) and web (heading anchors, upstream link rewrite) so
 * the anchor a section row links to always matches the id the page renders.
 */

/** `rel_` + 21 nanoid chars, optionally followed by `-slug`. Capture = id. */
const RELEASE_LINK_RE = /\/release\/(rel_[A-Za-z0-9_-]{21})(?:-[^)\s]*)?/g;
/** A whole markdown link whose target is a release path. */
const RELEASE_MD_LINK_RE = /\]\(\/release\/(rel_[A-Za-z0-9_-]{21})(?:-[^)\s]*)?\)/g;

export interface ParsedDigestSection {
  heading: string;
  anchor: string;
  /** First sentence of the section's first paragraph, markdown stripped. */
  lede: string;
  /** Unique cited release ids, first-seen order. */
  releaseIds: string[];
}

export function digestSectionAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/['‘’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripInlineMarkdown(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|\*|_)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(paragraph: string): string {
  const text = stripInlineMarkdown(paragraph);
  const m = /^(.+?[.!?])(?=\s+[A-Z0-9"“(]|$)/.exec(text);
  return (m ? m[1] : text).trim();
}

export function parseDigestSections(body: string): ParsedDigestSection[] {
  const parts = body.split(/^###[ \t]+/m).slice(1);
  return parts.map((part) => {
    const nl = part.indexOf("\n");
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    const rest = nl === -1 ? "" : part.slice(nl + 1);
    const firstPara = rest.trim().split(/\n\s*\n/)[0] ?? "";
    const releaseIds: string[] = [];
    for (const m of rest.matchAll(RELEASE_LINK_RE)) {
      if (!releaseIds.includes(m[1])) releaseIds.push(m[1]);
    }
    return {
      heading,
      anchor: digestSectionAnchor(heading),
      lede: firstPara ? firstSentence(firstPara) : "",
      releaseIds,
    };
  });
}

/** The `rel_…` id from an on-site release path (`/release/rel_<id>[-slug]`), else null. */
export function releaseIdFromPath(href: string): string | null {
  const m = /^\/release\/(rel_[A-Za-z0-9_-]{21})(?:-[^/?#\s]*)?(?:[?#].*)?$/.exec(href.trim());
  return m ? m[1] : null;
}

/** Replace `](/release/rel_…)` link targets with the release's upstream url
 *  when it has an http(s) one; otherwise leave the internal fallback. Mirrors
 *  `releaseLinkTarget()` in web/src/lib/release-link.ts. */
export function rewriteDigestReleaseLinks(
  body: string,
  urlById: ReadonlyMap<string, string | null | undefined>,
): string {
  return body.replace(RELEASE_MD_LINK_RE, (match, id: string) => {
    const url = (urlById.get(id) ?? "").trim();
    return /^https?:\/\//i.test(url) ? `](${url})` : match;
  });
}
```

Add to `packages/rendering/package.json` `exports`: `"./digest-sections": "./src/digest-sections.ts",`

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/rendering/src/digest-sections.test.ts`
Expected: PASS (all tests). If the lede test fails on the `**Claude Code**` case, check the emphasis regex runs after link stripping.

- [ ] **Step 5: Commit**

```bash
git add packages/rendering/src/digest-sections.ts packages/rendering/src/digest-sections.test.ts packages/rendering/package.json
git commit -m "feat(rendering): parse digest sections and rewrite release links to upstream"
```

---

### Task 2: Wire types — covered-release upstream url/product/avatar + digest sections

**Files:**
- Modify: `packages/api-types/src/schemas/collections.ts` (around `DigestCoveredReleaseSchema`, line ~273, and `CollectionWeeklyDigestDetailSchema`)
- Modify: `packages/api-types/src/api-types.ts` (re-export list near line 277/627 and type exports near line 1750)
- Create: `.changeset/digest-sections-upstream-links.md`

**Interfaces:**
- Produces (types consumed by Tasks 3–8):
  - `DigestCoveredRelease` gains `url?: string | null`, `product?: { slug: string; name: string } | null`, `org.avatarUrl?: string | null`, `org.githubHandle?: string | null`
  - `DigestSection = { heading: string; anchor: string; lede: string; releaseIds: string[] }`
  - `CollectionWeeklyDigestDetail` gains `sections?: DigestSection[]`

- [ ] **Step 1: Edit the schemas** (all new fields optional → additive)

```ts
/** Minimal, server-resolved release info for a digest's "Releases covered" list. */
export const DigestCoveredReleaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Internal `/release/*` path — fallback link only (see `url`). */
  path: z.string(),
  /** Upstream source URL. Primary link target when http(s); optional for older servers. */
  url: z.string().nullable().optional(),
  org: z.object({
    slug: z.string(),
    name: z.string(),
    avatarUrl: z.string().nullable().optional(),
    githubHandle: z.string().nullable().optional(),
  }),
  /** Product the release's source belongs to, when it has one. */
  product: z.object({ slug: z.string(), name: z.string() }).nullable().optional(),
  importance: ImportanceScoreSchema,
});

/** One `###` section of a digest body, parsed server-side. */
export const DigestSectionSchema = z.object({
  heading: z.string(),
  /** Slug the digest page renders as the heading's `id` — link target `#anchor`. */
  anchor: z.string(),
  /** First sentence of the section, plain text. */
  lede: z.string(),
  /** Cited release ids in first-seen order; resolve against the detail's `releases`. */
  releaseIds: z.array(z.string()),
});
```

In `CollectionWeeklyDigestDetailSchema` add after `releases`:

```ts
  /** Parsed `###` sections. Optional for older servers. */
  sections: z.array(DigestSectionSchema).optional(),
```

Re-export `DigestSectionSchema` from `api-types.ts` alongside `DigestCoveredReleaseSchema` (both export lists), and add `export type DigestSection = z.infer<typeof DigestSectionSchema>;` next to `DigestCoveredRelease`.

- [ ] **Step 2: Type-check**

Run: `bun run lint`
Expected: no new errors.

- [ ] **Step 3: Changeset**

```bash
bun run changeset
```
Pick `@buildinternet/releases-api-types`, **minor**, summary: "Digest covered releases carry the upstream `url`, `product`, and org avatar; digest detail adds parsed `sections`."

- [ ] **Step 4: Commit**

```bash
git add packages/api-types .changeset
git commit -m "feat(api-types): digest sections and upstream release links"
```

---

### Task 3: API — resolve upstream url/product/avatar; sections on digest detail

**Files:**
- Modify: `workers/api/src/queries/collection-summaries.ts` (`resolveDigestCoveredReleases`, ~line 408)
- Modify: `workers/api/src/routes/collections.ts` (detail handler ~line 938)
- Test: `workers/api/src/queries/collection-summaries.test.ts`

**Interfaces:**
- Consumes: `parseDigestSections` (Task 1), `DigestCoveredRelease` (Task 2)
- Produces: `resolveDigestCoveredReleases(db, ids): Promise<DigestCoveredRelease[]>` with `url`, `product`, `org.avatarUrl`, `org.githubHandle` populated.

- [ ] **Step 1: Write the failing test** (append to `collection-summaries.test.ts`; reuse the file's `seedOrgSource` helper; add `resolveDigestCoveredReleases` to the import list)

```ts
describe("resolveDigestCoveredReleases", () => {
  test("returns upstream url, product, and org avatar in input order", async () => {
    const { db } = createTestDb();
    await seedOrgSource(db, { orgId: "org_d", sourceId: "src_d", productId: "prod_d" });
    await seedOrgSource(db, { orgId: "org_e", sourceId: "src_e" });
    await db.update(organizations).set({ avatarUrl: "https://media.example.com/org_d.png" }).where(eq(organizations.id, "org_d"));
    await db.insert(releases).values([
      { id: "rel_d", sourceId: "src_d", title: "D", content: "b", url: "https://example.com/changelog#d", publishedAt: "2026-09-15T00:00:00.000Z" },
      { id: "rel_e", sourceId: "src_e", title: "E", content: "b", url: null, publishedAt: "2026-09-16T00:00:00.000Z" },
    ]);

    const out = await resolveDigestCoveredReleases(db, ["rel_e", "rel_missing", "rel_d"]);

    expect(out.map((r) => r.id)).toEqual(["rel_e", "rel_d"]);
    expect(out[1]).toMatchObject({
      url: "https://example.com/changelog#d",
      product: { slug: "prod_d", name: "Product prod_d" },
      org: { slug: "org_d", avatarUrl: "https://media.example.com/org_d.png" },
    });
    expect(out[0]).toMatchObject({ url: null, product: null });
    expect(out[0].path.startsWith("/release/rel_e")).toBe(true);
  });
});
```

Add `import { eq } from "drizzle-orm";` if not present.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test workers/api/src/queries/collection-summaries.test.ts -t resolveDigestCoveredReleases`
Expected: FAIL — `url`/`product` undefined.

- [ ] **Step 3: Implement** — extend the select and mapping in `resolveDigestCoveredReleases`:

```ts
        .select({
          id: releasesVisible.id,
          title: releasesVisible.title,
          titleGenerated: releasesVisible.titleGenerated,
          titleShort: releasesVisible.titleShort,
          version: releasesVisible.version,
          importance: releasesVisible.importance,
          url: releasesVisible.url,
          orgSlug: organizationsPublic.slug,
          orgName: organizationsPublic.name,
          orgAvatarUrl: organizationsPublic.avatarUrl,
          orgGithubHandle: organizationsPublic.githubHandle,
          productSlug: productsActive.slug,
          productName: productsActive.name,
        })
        .from(releasesVisible)
        .innerJoin(sourcesVisible, eq(sourcesVisible.id, releasesVisible.sourceId))
        .innerJoin(organizationsPublic, eq(organizationsPublic.id, sourcesVisible.orgId))
        .leftJoin(productsActive, eq(productsActive.id, sourcesVisible.productId))
        .where(inArray(releasesVisible.id, idChunk)),
```

and in the mapper:

```ts
      {
        id: r.id,
        title: r.titleGenerated ?? r.title,
        path: releasePath({ id: r.id, titleShort: r.titleShort, titleGenerated: r.titleGenerated, title: r.title, version: r.version }),
        url: r.url ?? null,
        org: { slug: r.orgSlug, name: r.orgName, avatarUrl: r.orgAvatarUrl ?? null, githubHandle: r.orgGithubHandle ?? null },
        product: r.productSlug && r.productName ? { slug: r.productSlug, name: r.productName } : null,
        importance: r.importance ?? null,
      },
```

Update the doc comment: "…(title, org, upstream url, product, canonical `/release/*` fallback path)…". If `organizationsPublic` lacks `githubHandle`/`avatarUrl` columns, check `packages/core/src/schema.ts` for the view's column names and use those.

- [ ] **Step 4: Sections on the detail route** — in `workers/api/src/routes/collections.ts`, import `parseDigestSections` from `@releases/rendering/digest-sections` and add to the JSON body (after `releases`):

```ts
      sections: parseDigestSections(digest.body),
```

Also update the route's OpenAPI description sentence to mention `sections` and that `releases[].url` is the primary link.

- [ ] **Step 5: Run the API suites**

Run: `bun test workers/api/src/queries/collection-summaries.test.ts && bun test workers/api -t digest`
Expected: PASS. Fix any existing route test that snapshots the detail body (add `sections`).

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/queries/collection-summaries.ts workers/api/src/queries/collection-summaries.test.ts workers/api/src/routes/collections.ts
git commit -m "feat(api): digest detail returns sections and upstream release links"
```

---

### Task 4: GraphQL — `latestWeeklyDigests` root field for the homepage

**Files:**
- Modify: `workers/api/src/queries/collection-summaries.ts` (new `listLatestWeeklyDigests`)
- Modify: `workers/api/src/graphql/builder.ts` (Objects map), `workers/api/src/graphql/types/collection.ts` (types), `workers/api/src/graphql/schema.ts` (root field)
- Test: `workers/api/src/queries/collection-summaries.test.ts`, `workers/api/test/graphql.test.ts`
- Regenerate: `packages/api-types/graphql/schema.graphql`

**Interfaces:**
- Consumes: `resolveDigestCoveredReleases` (Task 3), `parseDigestSections` (Task 1)
- Produces:
  - `listLatestWeeklyDigests(db): Promise<LatestWeeklyDigest[]>` where
    `type LatestWeeklyDigest = { collection: { slug: string; name: string; isFeatured: boolean }; weekStart: string; title: string; intro: string; releaseCount: number; sections: Array<ParsedDigestSection & { releases: DigestCoveredRelease[] }>; orgs: DigestCoveredRelease["org"][] }`
  - GraphQL: `latestWeeklyDigests: [WeeklyDigestPreview!]!` (all digests sharing the newest `weekStart`, public collections only). Types `WeeklyDigestPreview`, `WeeklyDigestSection`, `DigestRelease`, `DigestReleaseOrg`, `DigestReleaseProduct`, `WeeklyDigestCollection`.

- [ ] **Step 1: Failing query test** (append to `collection-summaries.test.ts`; import `collectionWeeklyDigests` from schema and `listLatestWeeklyDigests`)

```ts
describe("listLatestWeeklyDigests", () => {
  test("returns only the newest week, with sections resolved and orgs deduped", async () => {
    const { db } = createTestDb();
    await seedOrgSource(db, { orgId: "org_x", sourceId: "src_x", productId: "prod_x" });
    await db.insert(releases).values([
      { id: "rel_aaaaaaaaaaaaaaaaaaaaa", sourceId: "src_x", title: "A", content: "b", url: "https://example.com/a", publishedAt: "2026-09-15T00:00:00.000Z" },
    ]);
    await db.insert(collections).values([
      { id: "col_1", slug: "one", name: "One", isFeatured: true },
      { id: "col_2", slug: "two", name: "Two" },
    ]);
    const body = "### First\n\nLead sentence here. More. [A](/release/rel_aaaaaaaaaaaaaaaaaaaaa-a)\n";
    const base = { title: "T", intro: "I", releaseCount: 3, modelId: null, releaseIds: JSON.stringify(["rel_aaaaaaaaaaaaaaaaaaaaa"]), generatedAt: "2026-09-21T06:00:00.000Z" };
    await db.insert(collectionWeeklyDigests).values([
      { id: "cwd_new1", collectionId: "col_1", weekStart: "2026-09-14", body, ...base },
      { id: "cwd_old2", collectionId: "col_2", weekStart: "2026-09-07", body, ...base },
    ]);

    const out = await listLatestWeeklyDigests(db);

    expect(out).toHaveLength(1);
    expect(out[0].collection).toEqual({ slug: "one", name: "One", isFeatured: true });
    expect(out[0].sections[0]).toMatchObject({ heading: "First", anchor: "first", lede: "Lead sentence here." });
    expect(out[0].sections[0].releases[0].url).toBe("https://example.com/a");
    expect(out[0].orgs.map((o) => o.slug)).toEqual(["org_x"]);
  });
});
```

Before writing the insert, open `collectionWeeklyDigests` in `packages/core/src/schema.ts` and match its required columns (the `upsertCollectionWeeklyDigest` input in the same query file shows them; `releaseIds` may be stored as JSON text — mirror what `upsertCollectionWeeklyDigest` writes). Also confirm how `collections` marks public/hidden and filter the same way `getCollectionsList` (in `workers/api/src/queries/collections.ts`) does.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test workers/api/src/queries/collection-summaries.test.ts -t listLatestWeeklyDigests`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement `listLatestWeeklyDigests`**

```ts
export type LatestWeeklyDigest = {
  collection: { slug: string; name: string; isFeatured: boolean };
  weekStart: string;
  title: string;
  intro: string;
  releaseCount: number;
  sections: Array<ParsedDigestSection & { releases: DigestCoveredRelease[] }>;
  /** Distinct orgs across cited releases, first-seen order (facepile). */
  orgs: DigestCoveredRelease["org"][];
};

/**
 * Every public collection's digest for the newest digested week, for the
 * homepage reel. One query for the rows, one chunked hydrate for all cited
 * releases — no per-collection N+1.
 */
export async function listLatestWeeklyDigests(db: AnyDb): Promise<LatestWeeklyDigest[]> {
  const [latest] = await db
    .select({ weekStart: sql<string>`max(${collectionWeeklyDigests.weekStart})` })
    .from(collectionWeeklyDigests);
  if (!latest?.weekStart) return [];

  const rows = await db
    .select({
      weekStart: collectionWeeklyDigests.weekStart,
      title: collectionWeeklyDigests.title,
      intro: collectionWeeklyDigests.intro,
      body: collectionWeeklyDigests.body,
      releaseCount: collectionWeeklyDigests.releaseCount,
      slug: collections.slug,
      name: collections.name,
      isFeatured: collections.isFeatured,
    })
    .from(collectionWeeklyDigests)
    .innerJoin(collections, eq(collections.id, collectionWeeklyDigests.collectionId))
    .where(eq(collectionWeeklyDigests.weekStart, latest.weekStart));

  const parsed = rows.map((r) => ({ row: r, sections: parseDigestSections(r.body) }));
  const allIds = [...new Set(parsed.flatMap((p) => p.sections.flatMap((s) => s.releaseIds)))];
  const byId = new Map((await resolveDigestCoveredReleases(db, allIds)).map((r) => [r.id, r]));

  return parsed.map(({ row, sections }) => {
    const resolved = sections.map((s) => ({
      ...s,
      releases: s.releaseIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
    }));
    const orgs = new Map<string, DigestCoveredRelease["org"]>();
    for (const s of resolved) for (const r of s.releases) if (!orgs.has(r.org.slug)) orgs.set(r.org.slug, r.org);
    return {
      collection: { slug: row.slug, name: row.name, isFeatured: row.isFeatured },
      weekStart: row.weekStart,
      title: row.title,
      intro: row.intro,
      releaseCount: row.releaseCount,
      sections: resolved,
      orgs: [...orgs.values()],
    };
  });
}
```

Add imports: `collections` from schema, `parseDigestSections` / `ParsedDigestSection` from `@releases/rendering/digest-sections`. Apply the same hidden/public collection filter as `getCollectionsList` if collections have one.

- [ ] **Step 4: Run query test** — `bun test workers/api/src/queries/collection-summaries.test.ts` → PASS.

- [ ] **Step 5: GraphQL types.** In `builder.ts` `Objects`, add:

```ts
    WeeklyDigestPreview: LatestWeeklyDigest;
    WeeklyDigestCollection: LatestWeeklyDigest["collection"];
    WeeklyDigestSection: LatestWeeklyDigest["sections"][number];
    DigestRelease: DigestCoveredRelease;
    DigestReleaseOrg: DigestCoveredRelease["org"];
    DigestReleaseProduct: NonNullable<DigestCoveredRelease["product"]>;
```

In `types/collection.ts`:

```ts
const DigestReleaseOrgType = builder.objectType("DigestReleaseOrg", {
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    avatarUrl: t.exposeString("avatarUrl", { nullable: true }),
    githubHandle: t.exposeString("githubHandle", { nullable: true }),
  }),
});
const DigestReleaseProductType = builder.objectType("DigestReleaseProduct", {
  fields: (t) => ({ slug: t.exposeString("slug"), name: t.exposeString("name") }),
});
const DigestReleaseType = builder.objectType("DigestRelease", {
  description: "A release cited by a weekly digest. `url` (upstream) is the primary link; `path` is the on-site fallback.",
  fields: (t) => ({
    id: t.exposeID("id"),
    title: t.exposeString("title"),
    path: t.exposeString("path"),
    url: t.exposeString("url", { nullable: true }),
    org: t.expose("org", { type: DigestReleaseOrgType }),
    product: t.expose("product", { type: DigestReleaseProductType, nullable: true }),
  }),
});
const WeeklyDigestSectionType = builder.objectType("WeeklyDigestSection", {
  fields: (t) => ({
    heading: t.exposeString("heading"),
    anchor: t.exposeString("anchor"),
    lede: t.exposeString("lede"),
    releases: t.expose("releases", { type: [DigestReleaseType] }),
  }),
});
const WeeklyDigestCollectionType = builder.objectType("WeeklyDigestCollection", {
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    isFeatured: t.exposeBoolean("isFeatured"),
  }),
});
export const WeeklyDigestPreviewType = builder.objectType("WeeklyDigestPreview", {
  description: "One collection's digest for the newest digested week (homepage reel).",
  fields: (t) => ({
    collection: t.expose("collection", { type: WeeklyDigestCollectionType }),
    weekStart: t.exposeString("weekStart"),
    title: t.exposeString("title"),
    intro: t.exposeString("intro"),
    releaseCount: t.exposeInt("releaseCount"),
    sections: t.expose("sections", { type: [WeeklyDigestSectionType] }),
    orgs: t.expose("orgs", { type: [DigestReleaseOrgType] }),
  }),
});
```

In `schema.ts` root `queryType` fields, after `collections`:

```ts
    latestWeeklyDigests: t.field({
      type: [WeeklyDigestPreviewType],
      description:
        "Every public collection's digest for the newest digested week, with parsed sections and cited releases. Empty when no digests exist.",
      resolve: (_root, _args, ctx) => listLatestWeeklyDigests(ctx.db),
    }),
```

- [ ] **Step 6: GraphQL test** (append in `workers/api/test/graphql.test.ts` using the file's `mkDb` / `ctx` helpers and seed pattern from the `collection(slug:)` test near line 940)

```ts
  it("latestWeeklyDigests returns sections with upstream release urls", async () => {
    // seed: org_b + src_b1_1 exist from the shared fixtures; add a collection + digest
    await h.db.insert(collections).values({ id: "col_dg", slug: "dg", name: "DG" });
    const [rel] = await h.db.select({ id: releases.id }).from(releases).limit(1);
    await h.db.update(releases).set({ url: "https://example.com/up" }).where(eq(releases.id, rel.id));
    await h.db.insert(collectionWeeklyDigests).values({
      id: "cwd_dg", collectionId: "col_dg", weekStart: "2026-09-14", title: "T", intro: "I",
      body: `### S\n\nLede. [x](/release/${rel.id})\n`, releaseIds: JSON.stringify([rel.id]),
      releaseCount: 3, modelId: null, generatedAt: "2026-09-21T06:00:00.000Z",
    });
    const result = await graphql({
      schema,
      source: `query { latestWeeklyDigests { collection { slug } weekStart sections { anchor releases { url path org { slug } } } } }`,
      contextValue: ctx(h.db),
    });
    expect(result.errors).toBeUndefined();
    const d = (result.data as any).latestWeeklyDigests[0];
    expect(d.collection.slug).toBe("dg");
    expect(d.sections[0].anchor).toBe("s");
    expect(d.sections[0].releases[0].url).toBe("https://example.com/up");
  });
```

Match the seeding helper the surrounding tests actually use (`h.db`, fixture ids); adjust column names to the schema as in Step 1.

- [ ] **Step 7: Run and regenerate schema**

```bash
bun test workers/api/test/graphql.test.ts -t latestWeeklyDigests
bun workers/api/scripts/print-graphql-schema.ts
```
Expected: PASS; `packages/api-types/graphql/schema.graphql` gains the new types.

- [ ] **Step 8: Commit**

```bash
git add workers/api packages/api-types/graphql/schema.graphql
git commit -m "feat(api): latestWeeklyDigests GraphQL field for the homepage reel"
```

---

### Task 5: Homepage digest reel

**Files:**
- Create: `web/src/lib/graphql/operations/homepage-digests.graphql`
- Regenerate: `web/src/lib/graphql/__generated__/*` (incl. `persisted-documents.json`)
- Create: `web/src/lib/digest-reel.ts`, `web/src/lib/digest-reel.test.ts`
- Create: `web/src/components/digest-reel.tsx`
- Modify: `web/src/app/page.tsx`

**Interfaces:**
- Consumes: GraphQL `latestWeeklyDigests` (Task 4)
- Produces:
  - `type ReelDigest = HomepageDigestsQuery["latestWeeklyDigests"][number]`
  - `splitDigestReel(digests: ReelDigest[], cardCount?: number): { cards: ReelDigest[]; more: ReelDigest[] }` — featured first, then `releaseCount` desc, then name; default `cardCount = 6`
  - `sectionProducts(section): Array<{ key: string; name: string; org: { name; avatarUrl; githubHandle } }>` — distinct by product slug (fallback org slug), label = product name ?? org name
  - `<DigestReel digests={ReelDigest[]} />` client component

- [ ] **Step 1: Operation**

```graphql
# web/src/lib/graphql/operations/homepage-digests.graphql
query HomepageDigests {
  latestWeeklyDigests {
    collection { slug name isFeatured }
    weekStart
    title
    intro
    releaseCount
    orgs { slug name avatarUrl githubHandle }
    sections {
      heading
      anchor
      lede
      releases {
        id
        title
        url
        path
        org { slug name avatarUrl githubHandle }
        product { slug name }
      }
    }
  }
}
```

Run: `bun run --cwd web codegen` → commit the regenerated `__generated__` files (the API allowlists the new hash from `persisted-documents.json`).

- [ ] **Step 2: Failing tests for the pure helpers**

```ts
// web/src/lib/digest-reel.test.ts
import { describe, expect, test } from "bun:test";
import { splitDigestReel, sectionProducts, type ReelDigest } from "./digest-reel";

const org = (slug: string) => ({ slug, name: slug.toUpperCase(), avatarUrl: null, githubHandle: null });
const mk = (slug: string, releaseCount: number, isFeatured = false): ReelDigest =>
  ({ collection: { slug, name: slug, isFeatured }, weekStart: "2026-09-14", title: slug, intro: "", releaseCount, orgs: [], sections: [] }) as ReelDigest;

describe("splitDigestReel", () => {
  test("featured first, then by release count, capped at cardCount", () => {
    const { cards, more } = splitDigestReel([mk("a", 5), mk("b", 50), mk("c", 9, true), mk("d", 1)], 2);
    expect(cards.map((d) => d.collection.slug)).toEqual(["c", "b"]);
    expect(more.map((d) => d.collection.slug)).toEqual(["a", "d"]);
  });
});

describe("sectionProducts", () => {
  test("dedupes by product, falls back to org name", () => {
    const section = {
      heading: "h", anchor: "h", lede: "",
      releases: [
        { id: "1", title: "", url: null, path: "/release/1", org: org("openai"), product: { slug: "codex", name: "Codex" } },
        { id: "2", title: "", url: null, path: "/release/2", org: org("openai"), product: { slug: "codex", name: "Codex" } },
        { id: "3", title: "", url: null, path: "/release/3", org: org("neon"), product: null },
      ],
    } as ReelDigest["sections"][number];
    expect(sectionProducts(section).map((p) => p.name)).toEqual(["Codex", "NEON"]);
  });
});
```

Run: `bun test web/src/lib/digest-reel.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement helpers**

```ts
// web/src/lib/digest-reel.ts
import type { HomepageDigestsQuery } from "@/lib/graphql/__generated__/graphql";

export type ReelDigest = HomepageDigestsQuery["latestWeeklyDigests"][number];
type ReelSection = ReelDigest["sections"][number];

export function splitDigestReel(digests: ReelDigest[], cardCount = 6) {
  const sorted = [...digests].sort(
    (a, b) =>
      Number(b.collection.isFeatured) - Number(a.collection.isFeatured) ||
      b.releaseCount - a.releaseCount ||
      a.collection.name.localeCompare(b.collection.name),
  );
  return { cards: sorted.slice(0, cardCount), more: sorted.slice(cardCount) };
}

export function sectionProducts(section: ReelSection) {
  const out = new Map<string, { key: string; name: string; org: ReelSection["releases"][number]["org"] }>();
  for (const r of section.releases) {
    const key = r.product?.slug ?? `org:${r.org.slug}`;
    if (!out.has(key)) out.set(key, { key, name: r.product?.name ?? r.org.name, org: r.org });
  }
  return [...out.values()];
}

export function digestHref(d: Pick<ReelDigest, "collection" | "weekStart">, anchor?: string) {
  return `/collections/${d.collection.slug}/digest/${d.weekStart}${anchor ? `#${anchor}` : ""}`;
}
```

Run: `bun test web/src/lib/digest-reel.test.ts` → PASS.

- [ ] **Step 4: Component** — `web/src/components/digest-reel.tsx` (`"use client"`). Match `Main.dc.html` on the canvas. Structure and behavior:

```tsx
"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { OrgAvatar } from "./org-avatar";
import { isExternalReleaseLink, releaseLinkProps } from "@/lib/release-link";
import { weekOfLabel } from "@/lib/digest-format";
import { digestHref, sectionProducts, splitDigestReel, type ReelDigest } from "@/lib/digest-reel";

const HOVER_RELEASES = 3;

function ExternalArrow() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-stone-400 dark:text-stone-500">
      <path d="M7 17 17 7" /><path d="M8 7h9v9" />
    </svg>
  );
}

function SectionRow({ digest, section, index }: { digest: ReelDigest; section: ReelDigest["sections"][number]; index: number }) {
  const [open, setOpen] = useState(false);
  const products = sectionProducts(section);
  const more = section.releases.length - HOVER_RELEASES;
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <Link href={digestHref(digest, section.anchor)}
        className="-mx-2 flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800">
        <span className="font-mono text-[11px] text-stone-400 dark:text-stone-600">{String(index + 1).padStart(2, "0")}</span>
        <span className="min-w-0 flex-1 truncate">{section.heading}</span>
        <span className="flex pr-1" title={products.map((p) => p.name).join(", ")}>
          {products.map((p) => (
            <span key={p.key} className="-mr-1 rounded ring-[1.5px] ring-white dark:ring-stone-900">
              <OrgAvatar avatarUrl={p.org.avatarUrl} githubHandle={p.org.githubHandle} name={p.name} size={14} />
            </span>
          ))}
        </span>
      </Link>
      {open && (
        // pb-1.5 bridges the gap so the pointer can travel into the card.
        <div className="absolute bottom-full left-[-14px] z-20 hidden pb-1.5 md:block">
          <div className="flex w-[340px] flex-col gap-2.5 rounded-[10px] border border-stone-200 bg-white p-4 pb-3 shadow-xl dark:border-stone-700 dark:bg-[#262220]">
            <div className="flex flex-wrap gap-x-3 gap-y-1.5">
              {products.map((p) => (
                <span key={p.key} className="inline-flex items-center gap-1.5 text-[12px] font-medium text-stone-800 dark:text-stone-200">
                  <OrgAvatar avatarUrl={p.org.avatarUrl} githubHandle={p.org.githubHandle} name={p.name} size={16} />
                  {p.name}
                </span>
              ))}
            </div>
            {section.lede && <p className="text-[12.5px] leading-normal text-stone-500 dark:text-stone-400">{section.lede}</p>}
            <div className="flex flex-col gap-0.5 border-t border-stone-200 pt-2 dark:border-stone-700">
              {section.releases.slice(0, HOVER_RELEASES).map((r) => {
                const linkProps = releaseLinkProps(r) ?? { href: r.path, "data-release-id": r.id };
                return (
                  <a key={r.id} {...linkProps}
                    className="-mx-1.5 flex h-[26px] items-center gap-2 rounded px-1.5 text-[12px] text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800">
                    <OrgAvatar avatarUrl={r.org.avatarUrl} githubHandle={r.org.githubHandle} name={r.product?.name ?? r.org.name} size={14} />
                    <span className="min-w-0 flex-1 truncate">{r.title}</span>
                    {isExternalReleaseLink(linkProps) && <ExternalArrow />}
                  </a>
                );
              })}
              <div className="mt-0.5 flex items-center justify-between">
                <span className="font-mono text-[10.5px] text-stone-400">
                  {section.releases.length} {section.releases.length === 1 ? "release" : "releases"}{more > 0 ? ` · +${more} more` : ""}
                </span>
                <Link href={digestHref(digest, section.anchor)} className="text-[12px] font-medium text-[var(--accent)]">Read the section →</Link>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

Then `DigestCard` (article; `w-[88%] sm:w-[360px]`, `h-[440px]` on sm+, snap-start; header = facepile of `digest.orgs.slice(0,3)` + collection name + `Sep 14–20` mono; `<h3><Link href={digestHref(digest)}>` title clamp 3; intro clamp 3; dashed divider + "In this issue" eyebrow + up to 3 `SectionRow`s; footer `"{releaseCount} releases · {orgs.length} orgs"` + `Read issue →` link). And `DigestReel`:

- Section band: full-bleed `border-y border-stone-200 bg-stone-100/60 dark:border-stone-900 dark:bg-[#110f0e] py-12`.
- Header inside `max-w-[1240px] mx-auto px-6`: newspaper icon + `Weekly digests` (same eyebrow classes as the "Featured" heading in `app/page.tsx`), 22px title "The week in releases, written up by collection", subline `New issues every Monday. {weekOfLabel(weekStart)} · {n} collections`, and prev/next 44px buttons (`aria-label="Previous digests"` / `"Next digests"`) that call `scrollBy({ left: ±376, behavior: "smooth" })` on the track ref; disable at the ends via `onScroll` state.
- Track: `flex gap-4 overflow-x-auto snap-x snap-mandatory scroll-px-6` with left padding aligned to the 1240 column: `pl-[max(1.5rem,calc((100vw-1240px)/2+1.5rem))] pr-6`, hide scrollbar (`[scrollbar-width:none]`).
- "Also this week" row under the track: mono eyebrow + links to `digestHref(d)` for each `more` digest (collection name), then `All collections →` link to `/collections` pushed right.
- Return `null` when `digests.length === 0`.

Hover card is `md:block` only; on touch the row is a plain link. Reduced motion: use `behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"`.

- [ ] **Step 5: Wire into `app/page.tsx`** — add a fourth fetch to the existing `Promise.all`, fail-soft like collections:

```ts
      graphqlRequest(HomepageDigestsDocument, {}).catch(
        () => ({ latestWeeklyDigests: [] }) as HomepageDigestsQuery,
      ),
```

Store `latestDigests = digestsResult.latestWeeklyDigests`, and render `{latestDigests.length > 0 && <DigestReel digests={latestDigests} />}` between the closing `</div>` of the Featured/`OrgTable` grid and `<AgentUseCases />`, with `mt-4` spacing.

- [ ] **Step 6: Verify in the browser** — `preview_start` the web dev server (see `docs/architecture/local-development.md`), load `/`, check: band renders below the org table; arrows scroll; hovering a section shows the card and the pointer can move into it; release links open upstream in a new tab; section links go to `/collections/<slug>/digest/<week>#<anchor>`; dark and light; 390px width shows one card + peek. Screenshot for the PR.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/graphql web/src/lib/digest-reel.ts web/src/lib/digest-reel.test.ts web/src/components/digest-reel.tsx web/src/app/page.tsx
git commit -m "feat(web): weekly digest reel on the homepage"
```

---

### Task 6: Collection page — latest-issue hero

**Files:**
- Create: `web/src/components/latest-digest-hero.tsx`
- Modify: `web/src/app/collections/[slug]/page.tsx` (lines ~48–67, ~109–118, ~138–146)
- Modify: `web/src/app/collections/[slug]/digest/_lib/digest-data.ts` (`RECENT_DIGESTS_LIMIT` → 8)
- Modify: `web/src/components/collection-context-rail.tsx` (remove the digests box + `digests` prop)

**Interfaces:**
- Consumes: REST `api.collectionWeeklyDigest(slug, weekStart)` → `CollectionWeeklyDigestDetail` with `sections` + enriched `releases` (Tasks 2–3); `getRecentDigests(slug)`
- Produces: `<LatestDigestHero slug={string} digest={CollectionWeeklyDigestDetail} earlier={CollectionWeeklyDigestListItem[]} />`; `sectionProductsFromDetail(section: DigestSection, byId: Map<string, DigestCoveredRelease>)` exported from `web/src/lib/digest-reel.ts` (same dedupe rule as `sectionProducts`).

- [ ] **Step 1: Failing test for `sectionProductsFromDetail`** (append to `web/src/lib/digest-reel.test.ts`)

```ts
import { sectionProductsFromDetail } from "./digest-reel";

test("sectionProductsFromDetail resolves ids through the releases map", () => {
  const byId = new Map([
    ["r1", { id: "r1", title: "", path: "/release/r1", url: null, importance: null, org: { slug: "openai", name: "OpenAI" }, product: { slug: "codex", name: "Codex" } }],
    ["r2", { id: "r2", title: "", path: "/release/r2", url: null, importance: null, org: { slug: "cognition", name: "Cognition" }, product: { slug: "devin", name: "Devin" } }],
  ]);
  const out = sectionProductsFromDetail({ heading: "h", anchor: "h", lede: "", releaseIds: ["r1", "rX", "r2", "r1"] }, byId as any);
  expect(out.map((p) => p.name)).toEqual(["Codex", "Devin"]);
});
```

Run → FAIL. Implement in `digest-reel.ts`:

```ts
import type { DigestCoveredRelease, DigestSection } from "@buildinternet/releases-api-types";

export function sectionProductsFromDetail(section: DigestSection, byId: Map<string, DigestCoveredRelease>) {
  const out = new Map<string, { key: string; name: string; org: DigestCoveredRelease["org"] }>();
  for (const id of section.releaseIds) {
    const r = byId.get(id);
    if (!r) continue;
    const key = r.product?.slug ?? `org:${r.org.slug}`;
    if (!out.has(key)) out.set(key, { key, name: r.product?.name ?? r.org.name, org: r.org });
  }
  return [...out.values()];
}
```

Run → PASS.

- [ ] **Step 2: Hero component** (server component, `.org-surface` tokens; match `Collection-Hero.dc.html` top half):
  - `<article>` two columns (`md:flex`, stacks on mobile): left = mono eyebrow `This week's digest` in `var(--accent)` + `weekRangeLabel` (e.g. "Sep 14 – 20, 2026" — add a formatter beside `weekOfLabel` in `web/src/lib/digest-format.ts` with a unit test), `h2` title 26px, intro 15px `var(--fg-2)`, then a `Read the digest` button (`bg-[var(--fg)] text-[var(--page)]`, h-10) and `{releaseCount} releases covered` mono.
  - Right column `md:w-[400px]`, `bg-[var(--surface-2)]`/border-left: "In this issue" eyebrow, then per section a `Link` to `/collections/${slug}/digest/${weekStart}#${anchor}` containing: `01` mono, heading 14px, and a subline of `OrgAvatar size={14}` + product name for each of `sectionProductsFromDetail(...)`, plus `{n} releases` mono. No ↗.
  - Under the article, "Earlier" strip: up to 2 of `earlier` as `Sep 7  <title>` links, then `All digests →` to `/collections/${slug}/digest`.

- [ ] **Step 3: Wire the page** — replace the `latestDigest && <Link …>This week: …</Link>` block with:

```tsx
{latestDigestDetail && (
  <LatestDigestHero slug={slug} digest={latestDigestDetail} earlier={recentDigests.slice(1, 3)} />
)}
```

where, after `recentDigests` resolves:

```ts
const latestDigestDetail = latestDigest
  ? await api.collectionWeeklyDigest(slug, latestDigest.weekStart).catch(() => null)
  : null;
```

Remove `digests={recentDigests}` from `<CollectionContextRail>`, and delete the digests box, the `digests` prop, and the `weekOfLabel` import from `collection-context-rail.tsx` (keep Export + Report).

- [ ] **Step 4: Verify** — load `/collections/coding-agents` in the preview: hero sits under the description, section rows show product avatars, rail shows only Export/Report, mobile stacks cleanly. `bun run lint`.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/latest-digest-hero.tsx web/src/components/collection-context-rail.tsx web/src/app/collections web/src/lib/digest-reel.ts web/src/lib/digest-reel.test.ts web/src/lib/digest-format.ts
git commit -m "feat(web): lead collection pages with the latest digest"
```

---

### Task 7: Collection timeline — week dividers + inline digest cards

**Files:**
- Create: `web/src/lib/timeline-weeks.ts`, `web/src/lib/timeline-weeks.test.ts`
- Modify: `web/src/components/collection-timeline.tsx` (props ~line 33–60; render loop ~line 521–530)
- Modify: `web/src/app/collections/[slug]/page.tsx` (pass `digests`, `heroWeekStart`)

**Interfaces:**
- Consumes: `CollectionWeeklyDigestListItem[]` (newest-first, from `getRecentDigests`), `etWeekStart` from `@buildinternet/releases-core/dates`
- Produces:
  - `weekBoundaries(dayKeys: string[]): Map<string, string>` — maps the **first** day key (in the given newest-first order) of each ET week to that week's Monday `weekStart`
  - New optional props on `CollectionTimeline`: `digestsByWeek?: Map<string, CollectionWeeklyDigestListItem>`, `heroWeekStart?: string | null`, `digestBasePath?: string`

Behavior (from `Collection-Hero.dc.html`): before the first day of each ET week, render a divider row (`WEEK OF SEP 14` mono · `{n} releases` · rule). If that week has a digest: when `weekStart === heroWeekStart` render a **compact** one-line link card (icon · `DIGEST` · title · `Read →`); otherwise render the **full** inline card (eyebrow, title link, intro, `Read the digest →`, and the section headings list if the list item carries none — see note). The current (undigested) week's divider reads `in progress · digest Monday`. Weeks without a digest get only the divider. Category pages (which don't pass `digestsByWeek`) render exactly as today — no dividers.

Note: list items have no sections. The full inline card shows title + intro + link only. (Adding sections to list rows would need a body select + hydrate per row; not worth it for cards below the fold — revisit if wanted.)

- [ ] **Step 1: Failing test**

```ts
// web/src/lib/timeline-weeks.test.ts
import { describe, expect, test } from "bun:test";
import { weekBoundaries } from "./timeline-weeks";

describe("weekBoundaries", () => {
  test("marks the newest day of each ET week (Mon-start)", () => {
    const days = ["2026-09-22", "2026-09-21", "2026-09-20", "2026-09-14", "2026-09-13"];
    expect([...weekBoundaries(days)]).toEqual([
      ["2026-09-22", "2026-09-21"],
      ["2026-09-20", "2026-09-14"],
      ["2026-09-13", "2026-09-07"],
    ]);
  });
  test("ignores non-date keys", () => {
    expect([...weekBoundaries(["unknown"])]).toEqual([]);
  });
});
```

Run: `bun test web/src/lib/timeline-weeks.test.ts` → FAIL.

- [ ] **Step 2: Implement**

```ts
// web/src/lib/timeline-weeks.ts
import { etWeekStart, isDateKey } from "@buildinternet/releases-core/dates";

/** First (newest) day key of each ET week → that week's Monday. Input is newest-first. */
export function weekBoundaries(dayKeys: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let prevWeek: string | null = null;
  for (const key of dayKeys) {
    if (!isDateKey(key)) continue;
    const week = etWeekStart(key);
    if (week !== prevWeek) {
      out.set(key, week);
      prevWeek = week;
    }
  }
  return out;
}
```

Run → PASS.

- [ ] **Step 3: Render** — in `CollectionTimeline`, `const boundaries = useMemo(() => weekBoundaries(days.map((d) => d.key)), [days]);` then in the `days.map`, wrap each `DaySection` in a fragment that first renders `<WeekDivider …/>` + optional digest card when `digestsByWeek && boundaries.has(day.key)`. Week release count = sum of `releases.length` over loaded days in that week (label it without claiming completeness beyond the loaded page — just the number). "In progress" = `weekStart === etWeekStart(etDayKey(new Date()))` (import `etDayKey` from core dates). Keep the new components (`WeekDivider`, `InlineDigestCard`, `CompactDigestLink`) in the same file, below `DaySection`, using `.org-surface` tokens: card `bg-[color-mix(in_srgb,var(--accent)_7%,transparent)] border-[color-mix(in_srgb,var(--accent)_22%,transparent)]`.

- [ ] **Step 4: Pass props from the page**

```tsx
<CollectionTimeline
  …existing props…
  digestsByWeek={new Map(recentDigests.map((d) => [d.weekStart, d]))}
  heroWeekStart={latestDigest?.weekStart ?? null}
  digestBasePath={`/collections/${slug}/digest`}
/>
```

`digestsByWeek` is a Map crossing the server→client boundary — `summaryByDate` already does this, so it works; if Next complains, pass an array and build the Map inside the component.

- [ ] **Step 5: Verify** — preview `/collections/coding-agents`: current week divider says in progress; the hero's week shows the compact link; scroll/load-more to an older week shows the full card; `/categories/<slug>` unchanged. `bun test web/` passes.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/timeline-weeks.ts web/src/lib/timeline-weeks.test.ts web/src/components/collection-timeline.tsx web/src/app/collections
git commit -m "feat(web): week dividers and inline digests in the collection feed"
```

---

### Task 8: Digest page — upstream links + section anchors

**Files:**
- Modify: `web/src/lib/render-release-body.ts` (`RehypeBodyOpts`, `rehypeReleaseBody`, `renderBodyMarkdownToHtml` opts)
- Modify: `web/src/lib/render-digest-body.test.ts`
- Modify: `web/src/app/collections/[slug]/digest/[week]/page.tsx` (~line 136 body render; ~line 295 covered list)

**Interfaces:**
- Consumes: `rewriteDigestReleaseLinks`, `digestSectionAnchor` (Task 1); `releaseLinkTarget` (`web/src/lib/release-link.ts`); `DigestCoveredRelease.url` (Task 3)
- Produces: `renderBodyMarkdownToHtml(content, variant, { demoteHeadings?, headingIds?: (text: string) => string, releaseLinks?: ReadonlyMap<string, string | null> })`. When `releaseLinks` is set, every `<a href="/release/rel_…">` in the body is tagged `data-release-id`. If the map has an http(s) upstream url for that id, the href becomes the upstream url, opening in a new tab with the UGC rel; otherwise it stays an internal same-tab link.

- [ ] **Step 1: Failing tests** (append to `render-digest-body.test.ts`)

```ts
describe("renderBodyMarkdownToHtml headingIds", () => {
  test("adds ids to headings when a slugger is passed", async () => {
    const { digestSectionAnchor } = await import("@releases/rendering/digest-sections");
    const html = renderBodyMarkdownToHtml("### Agents learn to talk\n\nbody", "full", {
      demoteHeadings: 0,
      headingIds: digestSectionAnchor,
    });
    expect(html).toContain('<h3 id="agents-learn-to-talk">');
  });
  test("no ids by default", () => {
    expect(renderBodyMarkdownToHtml("### X\n\nb", "full", { demoteHeadings: 0 })).toContain("<h3>");
  });
});

describe("renderBodyMarkdownToHtml releaseLinks", () => {
  const A = "rel_JotzQfuFf_u8NV4btlouH";
  const B = "rel_ACOkQGJzq0IqqkhoWRR7C";
  test("rewrites release paths upstream and tags them", () => {
    const html = renderBodyMarkdownToHtml(`[a](/release/${A}-slug) and [b](/release/${B})`, "full", {
      demoteHeadings: 0,
      releaseLinks: new Map([[A, "https://example.com/a"], [B, null]]),
    });
    expect(html).toContain(`href="https://example.com/a"`);
    expect(html).toContain(`data-release-id="${A}"`);
    expect(html).toMatch(/href="https:\/\/example\.com\/a"[^>]*target="_blank"/);
    // No upstream → internal, same tab, still tagged.
    expect(html).toContain(`href="/release/${B}"`);
    expect(html).toContain(`data-release-id="${B}"`);
    expect(html).not.toMatch(new RegExp(`href="/release/${B}"[^>]*target=`));
  });
});
```

Run: `bun test web/src/lib/render-digest-body.test.ts` → FAIL.

- [ ] **Step 2: Implement** — add `headingIds?: (text: string) => string` to `RehypeBodyOpts` and the `opts` of `renderBodyMarkdownToHtml` (pass through in `.use(rehypeReleaseBody, { …, headingIds: opts?.headingIds })`). In the heading branch of `rehypeReleaseBody`, before `return;`:

```ts
        if (headingIds) {
          const text = hastText(node).trim();
          if (text) node.properties = { ...node.properties, id: headingIds(text) };
        }
```

with a local helper:

```ts
function hastText(node: any): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}
```

Run → PASS. Also add `scroll-mt-24` to digest `h3`s via the page's prose classes so anchored headings clear the sticky header.

  Then add `releaseLinks?: ReadonlyMap<string, string | null>` the same way. At the top of the `a` branch, after the `isSafeHref` guard:

```ts
        const releaseId = releaseLinks ? releaseIdFromPath(href) : null;
        if (releaseId) {
          const upstream = (releaseLinks!.get(releaseId) ?? "").trim();
          if (/^https?:\/\//i.test(upstream)) {
            node.properties = { ...node.properties, href: upstream, target: "_blank", rel: EXTERNAL_UGC_REL, dataReleaseId: releaseId };
          } else {
            node.properties = { ...node.properties, dataReleaseId: releaseId };
          }
          return;
        }
        // Same-origin app paths stay in-document: no new tab, no UGC rel.
        if (isInternalHref(href)) return;
```

(`dataReleaseId` is how hast spells `data-release-id`; rehype-stringify emits the dashed form. Import `releaseIdFromPath` from `@releases/rendering/digest-sections` and `isInternalHref` from `./sanitize`.) Run the test file → PASS.

- [ ] **Step 3: Digest page** — before rendering:

```ts
const releaseLinks = new Map(digest.releases.map((r) => [r.id, r.url ?? null]));
const bodyHtml = renderBodyMarkdownToHtml(digest.body, "full", {
  demoteHeadings: 0,
  headingIds: digestSectionAnchor,
  releaseLinks,
});
```

In the "Releases covered" list, replace `<Link href={r.path}>` with a small `CoveredReleaseLink` component in the same file:

```tsx
function CoveredReleaseLink({ release, className }: { release: DigestCoveredRelease; className: string }) {
  const linkProps = releaseLinkProps(release) ?? { href: release.path, "data-release-id": release.id };
  return isExternalReleaseLink(linkProps) ? (
    <a {...linkProps} className={`${className} inline-flex items-center gap-1`}>
      {release.title}
      <ExternalArrow />
    </a>
  ) : (
    <Link {...linkProps} className={className}>{release.title}</Link>
  );
}
``` Task 9 handles the page's JSON-LD `releaseUrls` (line ~161).

- [ ] **Step 4: Verify** — preview `/collections/coding-agents/digest/2026-09-14`: body links open `developers.openai.com`, `code.claude.com`, etc. in new tabs; `#agents-learn-to-talk` scrolls to the heading; covered list links go upstream with ↗. `bun test web/`.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/render-release-body.ts web/src/lib/render-digest-body.test.ts "web/src/app/collections/[slug]/digest/[week]/page.tsx"
git commit -m "fix(web): digest pages link releases upstream and anchor their sections"
```

---

### Task 9: Link-policy sweep — fixes that need no new wire fields

Context: a read-only sweep found the places below still making `/release/<id>` the **primary** link. `web/src/app/robots.ts` already `disallow`s `/release/`, so these links point crawlers and readers at pages that are both blocked and noindexed. The fixes here need no wire-type changes beyond Task 2. Leave the rest of the sweep for later (see "Deferred" below).

**Design decision (do not change):** the digest generator keeps writing internal `/release/rel_<id>` paths into stored bodies (`workers/api/src/cron/collection-summaries.ts:267`, `idToPath`). Those paths are how `parseDigestSections` finds each section's cited releases, so they serve as stable ids. Every renderer rewrites them to upstream with `rewriteDigestReleaseLinks` at read time. Add a comment above `idToPath` saying so.

**Files:**
- Modify: `packages/rendering/src/atom.ts` (`releaseAlternateHref`, ~line 90–104) + `packages/rendering/src/atom.test.ts` (~line 82)
- Modify: `web/src/lib/schema-org.ts` (`buildReleaseItemListJsonLd`, ~line 153) + create `web/src/lib/schema-org.test.ts`
- Modify: `web/src/components/related-rail.tsx` (`ReleaseCard`, ~line 131) + `web/src/components/related-rail.test.tsx`
- Modify: `packages/rendering/src/formatters.ts` (`collectionDigestToMarkdown`, ~line 831–885) + `packages/rendering/src/digest-formatters.test.ts`
- Modify: `web/src/app/collections/[slug]/digest/[week]/page.tsx` (JSON-LD `releaseUrls`, ~line 161)
- Modify: `workers/api/src/cron/collection-summaries.ts` (comment only, ~line 267)

**Interfaces:**
- Consumes: `rewriteDigestReleaseLinks` (Task 1), `DigestCoveredRelease.url` (Task 2), `releaseLinkTarget` (`web/src/lib/release-link.ts`)
- Produces: no new exports. Behavior: Atom `<link rel="alternate">` and JSON-LD `ItemList` items point upstream when a release has an http(s) `url`. The Atom `<id>` stays `/release/<id>`, since it's an identity and not a link.

- [ ] **Step 1: Atom — update the expectation first (failing)** in `atom.test.ts` (the fixture release has an upstream `url`; check `makeSource()` and use its value):

```ts
    // <id> stays the bare release path (stable identity, never a link target).
    expect(xml).toInclude("<id>https://releases.sh/release/rel_abc123</id>");
    // Human alternate goes upstream when the release has an http(s) url (#2218 link policy).
    expect(xml).toInclude(`<link rel="alternate" type="text/html" href="${makeSource().releases[0].url}" />`);
```

Add a second case: a release with `url: null` still gets the slugged `/release/<id>-<slug>` alternate. Run `bun test packages/rendering/src/atom.test.ts` → FAIL.

- [ ] **Step 2: Atom — implement**

```ts
/**
 * Human-facing `<link rel="alternate">` for an entry: the release's upstream
 * URL when it has an http(s) one (the #2218 link policy — /release/* pages are
 * noindexed and robots-disallowed), else the slugged on-site path. The atom
 * `<id>` stays the bare `/release/<id>` form (see `entryId`) — identity, not a link.
 */
function releaseAlternateHref(
  release: Pick<ReleaseItem, "id" | "url" | "titleShort" | "titleGenerated" | "title" | "version">,
  baseUrl: string,
): string | null {
  const url = (release.url ?? "").trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (!release.id) return null;
  return releaseWebUrl(baseUrl, { ...release, id: release.id });
}
```

Run → PASS. Fix any other `atom.test.ts` expectation that assumed the internal alternate (re-run the whole file).

- [ ] **Step 3: JSON-LD ItemList — failing test** (`web/src/lib/schema-org.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { buildReleaseItemListJsonLd } from "./schema-org";

describe("buildReleaseItemListJsonLd", () => {
  test("items link upstream when the release has an http url, else the release page", () => {
    const ld = buildReleaseItemListJsonLd(
      [
        { id: "rel_a", url: "https://example.com/changelog#a", title: "A" },
        { id: "rel_b", url: null, title: "B" },
      ] as any,
      { listId: "https://releases.sh/x#list", name: "X" },
    );
    const urls = (ld.itemListElement as any[]).map((e) => e.url ?? e.item?.url);
    expect(urls).toEqual(["https://example.com/changelog#a", "https://releases.sh/release/rel_b"]);
  });
});
```

Before running, check how each element exposes its URL in `schema-org.ts` (`url` vs `item.url`) and adjust the accessor. Run → FAIL.

- [ ] **Step 4: JSON-LD — implement** (line ~153):

```ts
      const link = releaseLinkTarget(release);
      const url = link ? (link.external ? link.href : `${SITE_URL}${link.href}`) : undefined;
```

Import `releaseLinkTarget` from `./release-link`. Update the adjacent comment ("the `/release/{id}` page it links to") to say the item links upstream, with the release page as fallback. Run → PASS.

- [ ] **Step 5: Related rail — failing test** (append to `related-rail.test.tsx`, reusing its `feedItem` fixture):

```ts
describe("RelatedRail ReleaseCard — link target", () => {
  test("links upstream in a new tab when the item has a url", () => {
    const html = renderToStaticMarkup(<ReleaseCard item={{ ...feedItem, url: "https://example.com/post" }} />);
    expect(html).toContain('href="https://example.com/post"');
    expect(html).toContain('target="_blank"');
  });
  test("falls back to the release page without a url", () => {
    const html = renderToStaticMarkup(<ReleaseCard item={{ ...feedItem, url: null }} />);
    expect(html).toContain(`href="/release/${feedItem.id}"`);
  });
});
```

Run → FAIL.

- [ ] **Step 6: Related rail — implement**

```tsx
  const linkProps = releaseLinkProps(item) ?? { href: `/release/${item.id}`, "data-release-id": item.id };
```

and spread `{...linkProps}` on the card's anchor. If the card renders through `next/link`, use a plain `<a>` when `isExternalReleaseLink(linkProps)`, like `shipping-now-ticker.tsx` `Card`. Also assert `data-release-id` in the new tests. Run → PASS.

- [ ] **Step 7: Digest `.md` — failing test** (append to `digest-formatters.test.ts`, reusing its digest fixture). Give one covered release `url: "https://example.com/up"` and have the body cite it as `[x](/release/<thatId>-slug)`:

```ts
  test("body links and the covered list point upstream when a url exists", () => {
    const md = collectionDigestToMarkdown(collection, digestWithUrls, { baseUrl: "https://releases.sh" });
    expect(md).toContain("[x](https://example.com/up)");
    expect(md).toContain("- [" + coveredTitle + "](https://example.com/up)");
    expect(md).not.toContain("/release/" + upstreamId);
  });
```

Run → FAIL.

- [ ] **Step 8: Digest `.md` — implement** in `collectionDigestToMarkdown`:

```ts
  const urlById = new Map(digest.releases.map((r) => [r.id, r.url ?? null]));
  …
  if (digest.body?.trim()) {
    lines.push(rewriteDigestReleaseLinks(digest.body.trim(), urlById));
    lines.push("");
  }
  …
      for (const r of group.items) {
        const upstream = (r.url ?? "").trim();
        const href = /^https?:\/\//i.test(upstream) ? upstream : opts.baseUrl ? `${opts.baseUrl}${r.path}` : r.path;
        lines.push(`- [${r.title}](${href})`);
      }
```

Import `rewriteDigestReleaseLinks` from `./digest-sections`. Run → PASS.

- [ ] **Step 9: Digest page JSON-LD** — change `releaseUrls` (page.tsx ~line 161) to:

```ts
      releaseUrls: digest.releases.map((r) => {
        const link = releaseLinkTarget(r);
        return link?.external ? link.href : `${SITE_URL}${link?.href ?? r.path}`;
      }),
```

- [ ] **Step 10: Cron comment** above `idToPath` in `workers/api/src/cron/collection-summaries.ts`:

```ts
    // Stored digest bodies keep internal /release/rel_<id> paths ON PURPOSE:
    // they are the stable ids `parseDigestSections` reads each section's cited
    // releases from. Renderers (web page, .md, homepage reel) swap them for the
    // upstream url at read time via `rewriteDigestReleaseLinks`.
```

- [ ] **Step 10b: Overview "Sources" chips go upstream** (user decision 2026-09-22; reverses #1934's on-domain preference in favor of #2218).
  - Create `web/src/lib/overview-citations.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { citationHref } from "./overview-citations";

describe("citationHref", () => {
  test("always the upstream source url, even when a release resolved", () => {
    expect(citationHref({ sourceUrl: "https://example.com/post", releaseId: "rel_a", releaseWebUrl: "https://releases.sh/release/rel_a" })).toBe("https://example.com/post");
  });
});
```

  Run → FAIL. Then in `overview-citations.ts`: `citationHref` returns `c.sourceUrl`. Delete `isInternalCitation` and update its doc comments. In `web/src/components/overview-source-chips.tsx`, make every chip external (`target="_blank"`, `rel={EXTERNAL_UGC_REL}`) and add `data-release-id={citation.releaseId ?? undefined}`, then remove the "internal release links: same-tab" comment. Update the `releaseWebUrl` doc comment in `packages/api-types/src/schemas/shared.ts` ("…kept for machine consumers; the web Sources footer links `sourceUrl`"). It's comment-only, so fold it into Task 2's changeset. Grep for other `isInternalCitation` / `releaseWebUrl` readers in `web/` and `workers/mcp/ui/` and align them. Run → PASS.

- [ ] **Step 11: Run everything touched**

```bash
bun test packages/rendering web/src/lib web/src/components/related-rail.test.tsx
bun test workers/api
```
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/rendering packages/api-types/src/schemas/shared.ts web/src/lib/schema-org.ts web/src/lib/schema-org.test.ts web/src/lib/overview-citations.ts web/src/lib/overview-citations.test.ts web/src/components/overview-source-chips.tsx web/src/components/related-rail.tsx web/src/components/related-rail.test.tsx "web/src/app/collections/[slug]/digest/[week]/page.tsx" workers/api/src/cron/collection-summaries.ts
git commit -m "fix: point Atom alternates, feed JSON-LD, overview sources, related rail and digest exports upstream"
```

**Deferred (not in this PR):**
- **Search results** (`web/src/components/search-results.tsx:111`) and **lookup rail** (`web/src/components/lookup-rail.tsx:168`) both need a new `url` field on the wire (`SearchReleaseHitSchema`, `LookupResultPayloadSchema.releases[]` in `packages/api-types/src/schemas/search.ts`) before the component fix. File one GitHub issue covering both (`--body-file`), with the file:line list above.
- **OK as-is, no action:** `webUrl` next to `url` in REST, MCP, and webhook payloads, since consumers can choose either. The `.md` `canonical=` attributes also stay, because they sit alongside `url=`. So do the "Details" and lightbox permalinks next to upstream title links.

---

## Final verification (before pushing)

- [ ] `bun run check`
- [ ] `bun test` (root; runs `workers/api` in its own process)
- [ ] `bun run --cwd web codegen` produces no diff (generated files committed)
- [ ] Preview screenshots: homepage band (desktop dark + light, 390px), collection hero + inline card, digest page anchors — attach to the PR with the `github-screenshots` skill
- [ ] PR body notes: api-types minor changeset; GraphQL persisted op added (web + API deploy together); no flag
