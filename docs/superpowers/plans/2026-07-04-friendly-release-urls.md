# Friendly Release URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zendesk-style release URLs — `/release/rel_<id>-<slug>` — where the
`rel_` ID is the only routing key, the slug is derived at request time from
`title_short`, and any bare-ID or stale-slug URL 301s to the current
canonical form.

**Architecture:** A pure helper module in `packages/core`
(`release-slug.ts`) owns slug derivation, path building, and positional
param parsing. The web release route and the API detail route both consume
it: web redirects to canonical and emits slugged canonical/OG URLs; the API
tolerates slugged IDs and adds an additive `webUrl` field to detail and
latest-list responses. No schema change, no AI pass, no backfill.

**Tech Stack:** TypeScript (strict), Bun, Next.js App Router (web), Hono on
Cloudflare Workers (API), zod schemas in `@buildinternet/releases-api-types`.

**Spec:** `docs/superpowers/specs/2026-07-04-friendly-release-urls-design.md`

## Global Constraints

- Work on branch `claude/eloquent-chatelet-992184`; never push to `main`.
- No DB schema change, no migration, no new AI generation pass, no backfill job.
- Releases stay OUT of the sitemap (`web/src/lib/sitemap-entries.ts` untouched).
- Existing bare-ID internal links are acceptable — do NOT sweep web components
  to rewrite `/release/${id}` link sites; they 301.
- Wire changes are additive only: new fields are `.optional()` in zod and `?`
  in interfaces.
- nanoid alphabet is `A-Za-z0-9_-`, length 21 — release IDs can contain `-`
  and `_`, so parsing is positional (`rel_` + exactly 21 chars), never
  delimiter-split.
- Slug cap: 80 chars, truncated on a hyphen boundary.
- `webUrl` base: `env.WEB_BASE_URL ?? "https://releases.sh"`, trailing slashes
  stripped.
- Verify with `bun run check` (root) and `bun test` before each commit; run
  `bunx oxfmt <file>` on any touched/added `.md` file before committing.
- Commit after every task (small, task-scoped commits).

---

### Task 1: Core `release-slug` module

**Files:**
- Create: `packages/core/src/release-slug.ts`
- Modify: `packages/core/package.json` (exports map, after the `"./slug"` line)
- Test: `tests/unit/release-slug.test.ts`

**Interfaces:**
- Consumes: `toSlug` from `packages/core/src/slug.ts` (existing:
  `toSlug(name: string): string`).
- Produces (later tasks import these from
  `@buildinternet/releases-core/release-slug`):
  - `interface ReleaseSlugInput { titleShort?: string | null; titleGenerated?: string | null; title?: string | null; version?: string | null }`
  - `releaseSlug(r: ReleaseSlugInput): string` — `""` when nothing usable.
  - `releasePath(r: { id: string } & ReleaseSlugInput): string` — `/release/<id>` or `/release/<id>-<slug>`.
  - `parseReleaseParam(segment: string): { id: string; slug: string | null }` — positional parse; non-matching input returns `{ id: segment, slug: null }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/release-slug.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import {
  parseReleaseParam,
  releasePath,
  releaseSlug,
} from "@buildinternet/releases-core/release-slug";

// 21-char nanoid body including the tricky alphabet members - and _
const BODY = "V1StGXR8_Z5jdHi6B-myT"; // exactly 21 chars, contains - and _
const REL = `rel_${BODY}`;

describe("releaseSlug", () => {
  it("prefers titleShort", () => {
    expect(
      releaseSlug({
        titleShort: "Claude Code 2.0 adds hooks",
        titleGenerated: "Something Else",
        title: "v2.0.0",
      }),
    ).toBe("claude-code-2-0-adds-hooks");
  });

  it("falls back titleShort -> titleGenerated -> title -> version", () => {
    expect(releaseSlug({ titleGenerated: "Gen Title" })).toBe("gen-title");
    expect(releaseSlug({ title: "Raw Title" })).toBe("raw-title");
    expect(releaseSlug({ version: "v2.3.1" })).toBe("v2-3-1");
  });

  it("skips empty/whitespace candidates in the chain", () => {
    expect(releaseSlug({ titleShort: "  ", title: "Real Title" })).toBe("real-title");
  });

  it("returns empty string when nothing usable", () => {
    expect(releaseSlug({})).toBe("");
    expect(releaseSlug({ title: "***" })).toBe("");
  });

  it("caps at 80 chars on a hyphen boundary", () => {
    const long = Array(30).fill("word").join(" "); // slug would be 149 chars
    const slug = releaseSlug({ title: long });
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.startsWith("word-word")).toBe(true);
  });

  it("hard-cuts an 80+ char run with no hyphen", () => {
    const slug = releaseSlug({ title: "x".repeat(120) });
    expect(slug).toBe("x".repeat(80));
  });
});

describe("releasePath", () => {
  it("appends the slug after the id", () => {
    expect(releasePath({ id: REL, titleShort: "Hooks ship" })).toBe(
      `/release/${REL}-hooks-ship`,
    );
  });

  it("emits the bare-id path when the slug is empty", () => {
    expect(releasePath({ id: REL })).toBe(`/release/${REL}`);
  });
});

describe("parseReleaseParam", () => {
  it("extracts id and slug positionally", () => {
    expect(parseReleaseParam(`${REL}-claude-code-2-0`)).toEqual({
      id: REL,
      slug: "claude-code-2-0",
    });
  });

  it("handles ids containing - and _ (nanoid alphabet)", () => {
    // The first 21 chars after rel_ are the id even though they contain hyphens.
    expect(parseReleaseParam(`${REL}-x`)).toEqual({ id: REL, slug: "x" });
  });

  it("returns bare id with null slug", () => {
    expect(parseReleaseParam(REL)).toEqual({ id: REL, slug: null });
  });

  it("passes through non-matching input unchanged (existing 404 path)", () => {
    expect(parseReleaseParam("rel_short")).toEqual({ id: "rel_short", slug: null });
    expect(parseReleaseParam("not-an-id")).toEqual({ id: "not-an-id", slug: null });
  });

  it("round-trips with releasePath", () => {
    const path = releasePath({ id: REL, titleShort: "Some Title Here" });
    const segment = path.slice("/release/".length);
    expect(parseReleaseParam(segment).id).toBe(REL);
  });

  it("is not fooled by a 21-char slug", () => {
    // Slug part happens to be 21 valid nanoid chars — id is still positional.
    const slug21 = "a".repeat(21);
    expect(parseReleaseParam(`${REL}-${slug21}`)).toEqual({ id: REL, slug: slug21 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/release-slug.test.ts`
Expected: FAIL — `Cannot find module '@buildinternet/releases-core/release-slug'`.

- [ ] **Step 3: Add the export map entry**

In `packages/core/package.json`, in `"exports"`, after the line
`"./slug": "./src/slug.ts",` add:

```json
    "./release-slug": "./src/release-slug.ts",
```

- [ ] **Step 4: Write the implementation**

Create `packages/core/src/release-slug.ts`:

```typescript
import { toSlug } from "./slug";

/**
 * Friendly release URLs (Zendesk-style): `/release/rel_<id>-<slug>`.
 *
 * The `rel_` ID is the only routing key; the slug is derived from the
 * current title at request time and is purely decorative. nanoid's default
 * alphabet includes `-` and `_`, so the segment is parsed positionally
 * (`rel_` + exactly 21 chars), never by splitting on a delimiter.
 */

const MAX_SLUG_LENGTH = 80;

/** `rel_` + 21-char nanoid body, then optionally `-<slug>`. */
const RELEASE_SEGMENT = /^(rel_[A-Za-z0-9_-]{21})(?:-(.+))?$/;

export interface ReleaseSlugInput {
  titleShort?: string | null;
  titleGenerated?: string | null;
  title?: string | null;
  version?: string | null;
}

function truncateOnHyphen(slug: string): string {
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  const cut = slug.slice(0, MAX_SLUG_LENGTH + 1);
  const boundary = cut.lastIndexOf("-");
  const truncated = boundary > 0 ? cut.slice(0, boundary) : slug.slice(0, MAX_SLUG_LENGTH);
  return truncated.replace(/-+$/, "");
}

/**
 * Slug for a release's friendly URL, from the best available title.
 * Returns `""` when no candidate yields a usable slug — callers emit the
 * bare-ID path in that case.
 */
export function releaseSlug(r: ReleaseSlugInput): string {
  for (const candidate of [r.titleShort, r.titleGenerated, r.title, r.version]) {
    if (!candidate) continue;
    const slug = toSlug(candidate);
    if (slug) return truncateOnHyphen(slug);
  }
  return "";
}

/** Canonical web path for a release: `/release/<id>` or `/release/<id>-<slug>`. */
export function releasePath(r: { id: string } & ReleaseSlugInput): string {
  const slug = releaseSlug(r);
  return slug ? `/release/${r.id}-${slug}` : `/release/${r.id}`;
}

/**
 * Positional parse of a `/release/:id` path segment. Extracts `rel_` + 21
 * chars as the ID; anything after a following `-` is decorative slug.
 * Input that doesn't match the shape passes through as the ID so existing
 * lookup/404 behavior is unchanged.
 */
export function parseReleaseParam(segment: string): { id: string; slug: string | null } {
  const m = RELEASE_SEGMENT.exec(segment.trim());
  if (!m) return { id: segment.trim(), slug: null };
  return { id: m[1], slug: m[2] ?? null };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/release-slug.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Lint/type-check and commit**

```bash
bun run check
git add packages/core/src/release-slug.ts packages/core/package.json tests/unit/release-slug.test.ts
git commit -m "feat(core): release-slug helpers for friendly release URLs"
```

---

### Task 2: Web route — parse, 301 canonicalization, slugged canonical/OG

**Files:**
- Modify: `web/src/app/release/[id]/page.tsx` (generateMetadata ~lines 34–70;
  page component ~lines 82–119)
- Modify: `web/src/app/release/[id]/opengraph-image.tsx` (~lines 18–21)
- Modify: `web/src/app/api/format/release/[id]/route.ts` (wherever the `id`
  param is read)

**Interfaces:**
- Consumes: `parseReleaseParam`, `releasePath` from
  `@buildinternet/releases-core/release-slug` (Task 1). `ReleaseDetail` from
  `api.release()` satisfies `ReleaseSlugInput` (it has `titleShort?`,
  `titleGenerated?`, `title`, `version`).
- Produces: user-visible behavior only — no exports.

- [ ] **Step 1: Update `generateMetadata` in `page.tsx`**

Add the import at the top of the file:

```typescript
import { parseReleaseParam, releasePath } from "@buildinternet/releases-core/release-slug";
```

In `generateMetadata`, replace:

```typescript
  const { id } = await params;
  try {
    const release = await api.release(id);
```

with:

```typescript
  const { id: rawParam } = await params;
  const { id } = parseReleaseParam(rawParam);
  try {
    const release = await api.release(id);
```

and replace the two URL emissions:

```typescript
      openGraph: {
        type: "article",
        url: `/release/${id}`,
        publishedTime: release.publishedAt ?? undefined,
      },
      alternates: { canonical: `/release/${id}` },
```

with:

```typescript
      openGraph: {
        type: "article",
        url: releasePath(release),
        publishedTime: release.publishedAt ?? undefined,
      },
      alternates: { canonical: releasePath(release) },
```

- [ ] **Step 2: Update the page component in `page.tsx`**

Replace:

```typescript
export default async function ReleaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let release;
  try {
    release = await api.release(id);
```

with:

```typescript
export default async function ReleaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawParam } = await params;
  const { id } = parseReleaseParam(rawParam);

  let release;
  try {
    release = await api.release(id);
```

Then, immediately AFTER the whole `try/catch` block that ends with
`notFound();` (i.e. once `release` is known-good), add the canonicalization
redirect:

```typescript
  // Friendly-URL canonicalization: bare-ID, stale-slug, and mangled-slug
  // segments all 301 to the current canonical `/release/<id>-<slug>` form.
  // The ID is the routing key; the slug is derived from the current title.
  const canonicalPath = releasePath(release);
  if (canonicalPath !== `/release/${rawParam}`) {
    permanentRedirect(canonicalPath);
  }
```

(`permanentRedirect` is already imported at the top of the file. Do NOT
change the coverage-redirect inside the catch — it targets the bare-ID path,
which now takes one extra 301 hop to the slugged form; accepted.)

- [ ] **Step 3: Update `opengraph-image.tsx`**

Add the import:

```typescript
import { parseReleaseParam } from "@buildinternet/releases-core/release-slug";
```

Replace:

```typescript
  const { id } = await params;
  try {
    const release = await api.release(id);
```

with:

```typescript
  const { id: rawParam } = await params;
  const { id } = parseReleaseParam(rawParam);
  try {
    const release = await api.release(id);
```

- [ ] **Step 4: Update the format route**

Open `web/src/app/api/format/release/[id]/route.ts`. Wherever the `id` route
param is extracted (e.g. `const { id } = await params;`), parse it the same
way:

```typescript
import { parseReleaseParam } from "@buildinternet/releases-core/release-slug";
// ...
const { id: rawParam } = await params;
const { id } = parseReleaseParam(rawParam);
```

and use `id` for the downstream fetch. Keep everything else unchanged.

- [ ] **Step 5: Type-check and test**

Run: `bun run check && bun test tests/ web/`
Expected: PASS, no new failures.

- [ ] **Step 6: Manual smoke (optional but recommended)**

Start `bun run dev:web` (and `dev:api` if not running), then:

```bash
curl -sI "https://releases.localhost/release/<some-rel-id>" | grep -i -E "^(HTTP|location)"
```

Expected: `308` (Next permanentRedirect) with `location: /release/<id>-<slug>`;
fetching the slugged URL returns `200`. (Any real `rel_` id from the local DB
works; skip if no local data.)

- [ ] **Step 7: Commit**

```bash
git add "web/src/app/release/[id]/page.tsx" "web/src/app/release/[id]/opengraph-image.tsx" "web/src/app/api/format/release/[id]/route.ts"
git commit -m "feat(web): Zendesk-style friendly release URLs with 301 canonicalization"
```

---

### Task 3: API — slug-tolerant `GET /v1/releases/:id` + `webUrl` on detail

**Files:**
- Modify: `workers/api/src/routes/sources.ts` (detail handler at
  `sourceRoutes.get("/releases/:id", ...)`, ~lines 3459–3572)
- Modify: `workers/api/src/queries/releases.ts` (add `releaseWebBase` export)
- Modify: `packages/api-types/src/schemas/releases.ts`
  (`ReleaseDetailResponseSchema`, ~line 217)
- Modify: `packages/api-types/src/api-types.ts` (`ReleaseDetail` interface,
  ~line 793)

**Interfaces:**
- Consumes: `parseReleaseParam`, `releasePath` from
  `@buildinternet/releases-core/release-slug` (Task 1).
- Produces:
  - `releaseWebBase(env: { WEB_BASE_URL?: string }): string` in
    `workers/api/src/queries/releases.ts` (Task 4 reuses it).
  - `webUrl?: string` on the `ReleaseDetail` wire shape.

- [ ] **Step 1: Add `releaseWebBase` to `workers/api/src/queries/releases.ts`**

Near the top-level exports (e.g. right above `mapLatestRowToReleaseItem`):

```typescript
/**
 * Absolute web origin for building `webUrl` fields. `WEB_BASE_URL` is set in
 * prod/staging wrangler config; the fallback keeps the prod origin so local
 * dev without the var still emits a well-formed URL.
 */
export function releaseWebBase(env: { WEB_BASE_URL?: string }): string {
  return (env.WEB_BASE_URL ?? "https://releases.sh").replace(/\/+$/, "");
}
```

- [ ] **Step 2: Make the detail route slug-tolerant and emit `webUrl`**

In `workers/api/src/routes/sources.ts`, add to the imports:

```typescript
import { parseReleaseParam, releasePath } from "@buildinternet/releases-core/release-slug";
```

and import `releaseWebBase` from `../queries/releases.js` (extend the
existing import from that module if one exists in this file, otherwise add
one).

In the `sourceRoutes.get("/releases/:id", ...)` handler, replace:

```typescript
    const id = c.req.param("id");
```

with:

```typescript
    // Accept the friendly `rel_<id>-<slug>` form: the ID is positional
    // (rel_ + 21 chars); any trailing slug is decorative and ignored.
    const id = parseReleaseParam(c.req.param("id")).id;
```

Then, in the `const result = { ... }` literal (after `video,`), add:

```typescript
      webUrl: `${releaseWebBase(c.env)}${releasePath({
        id: release.id,
        titleShort: release.titleShort,
        titleGenerated: release.titleGenerated,
        title: release.title,
        version: release.version,
      })}`,
```

(`release` here is the drizzle row with camelCase columns — `titleShort`,
`titleGenerated` exist on it.)

Also update the route's `describeRoute` `description` string: after the
sentence about `Accept: text/markdown`, append:

```
Accepts the friendly `rel_…-<slug>` URL segment form — the trailing slug is ignored for lookup. The response includes `webUrl`, the canonical releases.sh detail-page URL (Zendesk-style: ID + current title slug).
```

- [ ] **Step 3: Add `webUrl` to the detail schema and interface**

In `packages/api-types/src/schemas/releases.ts`, inside
`ReleaseDetailResponseSchema` (after the `url: z.string().nullable(),`
line), add:

```typescript
  /**
   * Canonical releases.sh detail-page URL, `https://releases.sh/release/
   * rel_<id>-<slug>` (Zendesk-style: immutable ID + current title slug;
   * the slug follows title regeneration, the ID keeps old links alive).
   * Additive — older servers omit it.
   */
  webUrl: z.string().optional(),
```

In `packages/api-types/src/api-types.ts`, inside `interface ReleaseDetail`
(after `url: string | null;`), add:

```typescript
  /**
   * Canonical releases.sh detail-page URL (friendly form: ID + current
   * title slug). Additive — older servers omit it.
   */
  webUrl?: string;
```

- [ ] **Step 4: Verify**

Run: `bun run check && bun test workers/api`
Expected: PASS. (The detail route has no direct unit test; the schema/type
changes are compile-gated and the parse helper is covered by Task 1 tests.)

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/sources.ts workers/api/src/queries/releases.ts packages/api-types/src/schemas/releases.ts packages/api-types/src/api-types.ts
git commit -m "feat(api): slug-tolerant release lookup + webUrl on release detail"
```

---

### Task 4: `webUrl` on latest-list items + api-types version bump

**Files:**
- Modify: `workers/api/src/queries/releases.ts`
  (`mapLatestRowToReleaseItem`, ~line 157)
- Modify: `workers/api/src/routes/releases.ts:283`,
  `workers/api/src/routes/feed.ts:30`, `workers/api/src/routes/me.ts:149`
  (mapper call sites)
- Modify: `packages/api-types/src/schemas/releases.ts`
  (`ReleaseLatestItemSchema`, ~line 47)
- Modify: `packages/api-types/package.json` (version bump)

**Interfaces:**
- Consumes: `releasePath` (Task 1), `releaseWebBase` (Task 3).
- Produces: `mapLatestRowToReleaseItem(r, mediaOrigin, webBase?)` — third
  param optional; when omitted (cron digest path) `webUrl` is absent.

- [ ] **Step 1: Extend the mapper**

In `workers/api/src/queries/releases.ts`, add the import:

```typescript
import { releasePath } from "@buildinternet/releases-core/release-slug";
```

Change the signature:

```typescript
export function mapLatestRowToReleaseItem(
  r: LatestReleaseRow,
  mediaOrigin: string,
  webBase?: string,
): ReleaseLatestItem {
```

and inside the returned object (after `url: r.url,`), add:

```typescript
    webUrl: webBase
      ? `${webBase}${releasePath({
          id: r.id,
          titleShort: r.title_short,
          titleGenerated: r.title_generated,
          title: r.title,
          version: r.version,
        })}`
      : undefined,
```

- [ ] **Step 2: Pass the base at the three route call sites**

Each of these files handles a Hono context `c`; import `releaseWebBase` from
`../queries/releases.js` (it's already imported for the mapper — extend that
import) and add the third argument:

`workers/api/src/routes/releases.ts:283`:

```typescript
      return rows.map((r) => mapLatestRowToReleaseItem(r, mediaOrigin, releaseWebBase(c.env)));
```

`workers/api/src/routes/feed.ts:30`:

```typescript
  const releases = rows.map((r) => mapLatestRowToReleaseItem(r, mediaOrigin, releaseWebBase(c.env)));
```

`workers/api/src/routes/me.ts:149`:

```typescript
    const items = pageRows.map((r) => mapLatestRowToReleaseItem(r, mediaOrigin, releaseWebBase(c.env)));
```

Leave `workers/api/src/cron/send-digests.ts:87` unchanged — digest email
rendering builds its own links; `webUrl` stays absent there by design.

- [ ] **Step 3: Add `webUrl` to `ReleaseLatestItemSchema`**

In `packages/api-types/src/schemas/releases.ts`, inside
`ReleaseLatestItemSchema` (after `url: z.string().nullable(),`), add:

```typescript
  /**
   * Canonical releases.sh detail-page URL (friendly form: ID + current
   * title slug). Additive — older servers and the digest-cron path omit it.
   */
  webUrl: z.string().optional(),
```

(`ReleaseLatestItem` is `z.infer` of this schema — no separate interface
edit needed.)

- [ ] **Step 4: Bump api-types minor version**

In `packages/api-types/package.json`, change `"version": "0.35.0"` to
`"version": "0.36.0"`. (npm publish is manual and happens out of band —
workspace consumers use `workspace:*`; the OSS CLI adopts on its next pin
bump.)

- [ ] **Step 5: Verify**

Run: `bun run check && bun test tests/ web/ workers/discovery workers/mcp workers/webhooks && bun test workers/api`
Expected: PASS across both test processes.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/queries/releases.ts workers/api/src/routes/releases.ts workers/api/src/routes/feed.ts workers/api/src/routes/me.ts packages/api-types/src/schemas/releases.ts packages/api-types/package.json
git commit -m "feat(api): webUrl on latest-list release items; api-types 0.36.0"
```

---

### Task 5: Docs

**Files:**
- Modify: `AGENTS.md` (Conventions section — one line)
- Modify: `docs/architecture/routing.md` (short subsection)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add the one-line convention to `AGENTS.md`**

In the Conventions section (near the REST-route-surface bullet), add:

```markdown
- **Friendly release URLs** — `/release/rel_<id>-<slug>`: the `rel_` ID (positional, `rel_` + 21 chars — nanoid may contain `-`/`_`) is the only routing key; the slug derives from `title_short` at request time (no stored column, no backfill) and stale/bare forms 301 to canonical. Helpers in `@buildinternet/releases-core/release-slug`. See [routing.md](docs/architecture/routing.md).
```

- [ ] **Step 2: Add the detail to `docs/architecture/routing.md`**

Add a short subsection (place it near the entity-resolution / lookups
material):

```markdown
## Friendly release URLs

Release detail pages use Zendesk-style URLs: `/release/rel_<id>-<slug>`
(e.g. `/release/rel_V1StGXR8_Z5jdHi6BmyTx-claude-code-2-0-adds-hooks`).

- **The ID is the only routing key.** Parsing is positional — `rel_` +
  exactly 21 chars — because nanoid's alphabet includes `-` and `_`, so the
  segment can never be delimiter-split. Anything after the next `-` is
  decorative and ignored (`parseReleaseParam` in
  `@buildinternet/releases-core/release-slug`).
- **The slug is derived, not stored.** `releaseSlug()` =
  `toSlug(titleShort ?? titleGenerated ?? title ?? version)`, capped at 80
  chars on a hyphen boundary. It follows title regeneration; the canonical
  URL churns with it (Zendesk semantics) and the immutable ID keeps every
  old link resolving.
- **Canonicalization:** the web route 301s any non-canonical segment
  (bare ID, stale slug, mangled slug) to the current canonical form.
  Canonical/OG metadata use the slugged path. Internal bare-ID links are
  acceptable — they redirect.
- **API:** `GET /v1/releases/:id` accepts the slugged segment (slug
  stripped before lookup). Detail and latest-list responses carry an
  additive `webUrl` — the absolute canonical web URL — built from
  `WEB_BASE_URL` (fallback `https://releases.sh`).
- **Sitemap:** release pages remain excluded (#1601 index-bloat cleanup);
  friendly URLs propagate via shared links, OG tags, and crawls of org/feed
  pages.
```

- [ ] **Step 3: Format and commit**

```bash
bunx oxfmt AGENTS.md docs/architecture/routing.md
git add AGENTS.md docs/architecture/routing.md
git commit -m "docs: friendly release URL convention + routing detail"
```

---

## Final verification (after all tasks)

- [ ] `bun run check` — clean.
- [ ] `bun test tests/ web/ workers/discovery workers/mcp workers/webhooks && bun test workers/api` — both processes pass.
- [ ] `cd workers/mcp && npx tsc --noEmit` — the carved-out workspace still
  type-checks (it consumes api-types; `webUrl` is additive so no changes
  expected, this is a guard).
- [ ] Open a PR from `claude/eloquent-chatelet-992184` (do not push to main).
