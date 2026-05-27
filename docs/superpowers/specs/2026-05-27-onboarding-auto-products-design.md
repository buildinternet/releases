# 1194 — Auto-create products at onboarding (discovery-agent grouping)

**Issue:** #1194 (parent #1190; arc: product-as-default-unit, #1187/#1189/#1190).
**Status:** design approved 2026-05-27. Build pending.

## Problem

The product layer turns on at **2+ products per org**, but products are hand-curated, so the trigger rarely fires (prod: 84 orgs, only 22 with products, 239 orphan sources). Onboarding today creates **org + sources** and never a product (`--into-product` only _attaches_ to an existing one; `evaluate.ts` is a per-URL fetch-method recommender, not a grouping step). Widen the trigger by having onboarding auto-create products.

## Locked decisions

- **Signal = the discovery agent groups.** It already enumerates a company's sources and has the web context to know "Vercel → Next.js, Turborepo, SWR." It tags each discovered source with the product it belongs to. (Rejected: one-product-per-source same-slug wrapping — creates ~239 trivial products, cuts against the #1190 lean precedent. Rejected: deterministic repo/domain heuristic — can't tell "blog + docs + flagship repo = one product" from three products.)
- **Onboarding only.** No backfill of the 62 existing productless orgs. Validate on new data first.
- **Provenance deferred.** `products` has no `discovery` column (only name/slug/orgId/kind). Marking auto-products `discovery='agent'` would need a schema edit + paired migration (CI gate). Out of scope; add when backfill/curation tooling lands.
- **Grouping discipline lives in the skills, not just the prompt.** The discovery _workers_ load skills, so the guidance must be in `managing-sources` + `finding-changelogs` (which exist in **both** the monorepo and the CLI), reinforced by the `discovery.ts` prompt.

## Representation — per-source product tag

Add two optional, additive fields to the discovered-source shape; the agent populates them **only when a company ships 2+ genuinely distinct products**, else leaves them unset (sources go org-direct, unchanged):

```ts
interface AgentDiscoveredSource {
  // …existing…
  productName?: string; // canonical product name, source naming rules (no org prefix)
  productSlug?: string; // stable kebab-case, per-org unique
}
```

Per-source tags beat a top-level `products[]` + sourceUrl lists: each source self-describes, so apply needs no fragile URL-matching, and the "2+ only" discipline is enforced upstream in the agent. (`productKind` deferred — kind is org-judgment, set later via curation.)

The discovery output is a **JSON state-file contract** — `AgentDiscoveredSource` is defined independently in the monorepo (`src/agent/discovery.ts`, `workers/discovery/src/types.ts`) and in the CLI (local type consumed by `onboard-apply.ts`). Additive optional fields are backward-compatible: the two repos only need matching field names, **no publish gating**.

## Components

### Monorepo PR (`buildinternet/releases`)

1. **Discovery types** — add `productName?`/`productSlug?` to `AgentDiscoveredSource` in `src/agent/discovery.ts` and thread through `workers/discovery/src/types.ts` (and `managed-discovery.ts` if it reshapes the output).
2. **Discovery prompt** (`src/agent/discovery.ts`) — add the _Grouping sources into products_ block (verbatim below) near where org/source structure is instructed. Auto-deploys to the managed discovery agent on merge.
3. **Skills** (`src/agent/skills/`) — add the grouping guidance to `managing-sources/SKILL.md` (operational) and `finding-changelogs/SKILL.md` (discovery-side). Auto-deploy on merge.

### CLI PR (`buildinternet/releases-cli`, separate, + changeset)

4. **Local discovery type** — mirror `productName?`/`productSlug?` on the CLI's `AgentDiscoveredSource`.
5. **Apply step** (`src/cli/commands/onboard-apply.ts`) — after `findOrg`, collect the distinct `(productSlug, productName)` set from `state.sources`; for each, **lookup-or-create** via `POST /v1/products` (orgId already required; reuse `findProduct`-then-create); build a `slug → productId` map; when applying each source, pass its `productId` so the source lands under the product. Sequential (the existing comment already notes "shared org/product lookup-or-create" racing).
6. **Skill copies** — mirror the same guidance into the CLI's `skills/managing-sources/SKILL.md` and `skills/finding-changelogs/SKILL.md` (cross-repo copies must stay in sync — the known 6-file drift set).

## Exact wording

### Discovery prompt + `managing-sources` (new subsection "### Grouping sources into products")

> **Grouping sources into products.** Most companies are single-product — leave `productSlug`/`productName` unset and sources attach directly to the org (the default).
>
> Only when a company ships **2 or more genuinely distinct products** — each with its own identity and release cadence (Vercel → Next.js, Turborepo, SWR; Datadog → APM, RUM, Browser SDK) — tag each discovered source with the product it belongs to: `productName` (canonical name, same naming rules as sources — no org prefix) and `productSlug` (stable kebab-case, per-org unique).
>
> A product is a distinct offering, **not**:
>
> - the company/engineering blog, newsroom, or all-in-one changelog → leave org-direct (untagged)
> - the docs site or marketing feed → org-direct
> - every individual GitHub repo by default — only repos that are themselves a recognized product
>
> If you can't name 2+ distinct products with confidence, tag nothing. Spurious products are worse than none.

### `finding-changelogs` (append to its multi-product context)

> When a company is multi-product (you found a multi-product `changelog.json`, or distinct product changelogs/repos), carry that grouping into onboarding by tagging each source with its `productName`/`productSlug` (see _Grouping sources into products_ in `managing-sources`). Index only the org's own products, not ecosystem/community plugins.

## Guardrails

- **2+-only** discipline in the prompt + skills; single-product orgs are byte-for-byte unchanged.
- **Idempotent** lookup-or-create on `(orgId, slug)` (`idx_products_org_slug`).
- **Slug collision** with a sibling source slug: reuse the #1190 warn-but-allow behavior; product wins bare-slug resolution, which is the intended product-first behavior.
- **AI-feature gating** unaffected — the org is curated via onboarding; auto-products inherit.

## Validation

- **Apply step** is deterministic: fixture `DiscoveryState` carrying product tags → assert lookup-or-create + correct `productId` attach (CLI unit test). Cover: no tags (org-direct, unchanged), 2 products, idempotent re-apply.
- **Agent grouping judgment** is not unit-testable — validate with a staging/real discovery run on a known multi-product company (Vercel) and eyeball the emitted tags. (Staging discovery has no CLI trigger — direct POST only.)

## Out of scope

- `products.discovery` provenance column (deferred).
- Backfill of existing productless orgs (separate decision).
- Web changes — the product grid + product pages already render at 2+ products (#1187/#1189/#1190); this just makes more orgs reach the threshold.

## Build sequence

Two independent PRs (JSON state-file contract; no publish dependency):

1. **Monorepo** — types + prompt + 2 skills (+ tests where the type is exercised).
2. **CLI** — local type + apply lookup-or-create/attach + 2 skill copies + changeset + apply test.

Land monorepo first so the discovery output starts carrying tags; the CLI apply consumes them. (A pre-CLI onboarding run just ignores the new fields — safe.)
