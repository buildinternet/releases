---
name: creating-releases-json
description: >-
  Create or update a releases.json manifest so registries and agents can find
  where a company or project publishes its release notes. Use this whenever
  someone wants to "list our product on Releases", "add a releases.json", "get
  indexed on releases.sh", declare a changelog / updates page / RSS feed /
  GitHub releases / App Store listing / CHANGELOG for discovery, publish a
  /.well-known/releases.json, or edit an existing one — even if they don't say
  "releases.json" by name. The manifest is a small, schema-validated file the
  owner hosts on their own domain or repo; this skill discovers the real publish
  locations, writes the correctly-scoped file, validates it locally, and guides
  publishing it.
---

# Creating a releases.json manifest

`releases.json` is a small, owner-declared file that states **what products a
company ships and where it publishes release notes** — a changelog, an updates
page, an RSS/Atom feed, GitHub Releases, an App Store listing, or a hosted
`CHANGELOG` file. Any registry or agent that reads the format (starting with
[releases.sh](https://releases.sh)) learns where the release notes live directly
from the owner instead of guessing.

**Authority comes from where the file lives, not from what it claims.** A file at
`https://{domain}/.well-known/releases.json` speaks for that whole company; a
`releases.json` at a repository root speaks only for that repo. That is the entire
trust model — if you can publish the file at the URL, you can declare what it says.

Your job with this skill: figure out which scope applies, discover the locations
where release notes **actually** live (never invent them), write a correctly-shaped
file, validate it, and help get it published.

## The one rule that matters most

**Only declare locations that really exist and respond.** The manifest states plain
facts about where updates are published. A guessed or aspirational URL is worse than
omitting it — it creates a broken source. Before writing any locator, confirm the URL
resolves (fetch it, or check it against the codebase/site). If you cannot verify a
location, leave it out and say so.

## Step 1 — Choose the scope

Decide which file you're writing. They share one schema but declare different things:

| You're working in…                                    | Write…                                  | It declares                                                       |
| ----------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| The repo that serves the company **website / domain** | `public/.well-known/releases.json` (or wherever that domain serves `/.well-known/`) | Company identity, `products[]`, and top-level `releases[]`        |
| A **single product / library repo**                   | `releases.json` at the **repo root**    | A `product` binding + where **this repo's** releases land         |

If unsure, ask: "Is this the repo that serves your marketing/docs domain, or a single
product repo?" A repo file **cannot** declare company identity; a domain file cannot
speak for a repo it doesn't host.

## Step 2 — Discover the real publish locations

Search the codebase and the company's site for every place product updates are
published. Look for, and **verify each one responds**:

- **Changelog / what's-new / updates pages** — `/changelog`, `/whats-new`,
  `/releases`, `updates.<domain>`, a "Product updates" blog category.
- **RSS/Atom feeds** — often linked from the changelog page's `<head>`
  (`<link rel="alternate" type="application/rss+xml">`), or a Canny/Beamer/Headway feed.
- **GitHub repos with Releases** — repos under the org that cut tagged releases or keep a
  `CHANGELOG.md`. Use `owner/repo`.
- **App Store listings** — for mobile apps whose release notes live in the store.
- **Hosted `CHANGELOG` documents** — a raw `CHANGELOG.md` served at a URL (not in GitHub).

Map each finding to a locator key:

| Key        | Use it for                                                        | Notes                                                        |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `url`      | The page a **person** reads — changelog / updates / what's-new    | The canonical human page. `https://` only.                   |
| `feed`     | The RSS/Atom feed machines follow                                 | May be third-party-hosted (Canny, Beamer…). `https://` only. |
| `github`   | A repo whose Releases are the record                              | `"owner/repo"`. In a **repo file only**, `"self"` = this repo. |
| `appstore` | An App Store listing URL                                          | `https://` only.                                             |
| `file`     | A raw changelog document at a URL (hosted `CHANGELOG.md`)         | `https://` only.                                             |

One `releases[]` entry can combine keys when they describe the **same** source — most
commonly `url` + `feed` (the page a human reads and the feed a machine follows for it).
Add `"title"` to name a location, and `"canonical": true` on the single primary entry
when several locations describe one product/repo scope (**at most one canonical per
scope**).

`source.url` is for humans. If a URL is purely a machine endpoint nobody would visit,
it belongs in `feed`/`file`, not `url`.

## Step 3 — Write the file

Start from the matching example in `examples/` and adapt it:

- `examples/domain-minimal.json` — the smallest useful file: `version` + `releases[]`.
- `examples/domain-products.json` — company identity + `products[]` + registry pin.
- `examples/repo.json` — a repo-root file with a `product` binding and `github: "self"`.

Rules to honor (the validator in Step 4 enforces all of these):

- **`"version": 2` is required.** v1 files are no longer read. `$schema`
  (`https://releases.sh/schemas/releases.json`) is optional but recommended — it gives
  editors autocomplete and validation.
- **Every `releases[]` entry needs ≥1 locator** (`url`/`feed`/`github`/`appstore`/`file`).
- **`url`/`feed`/`appstore`/`file`/`avatar` must be `https://`.** (`website`/`docs`/`support`
  on a product may be any valid URL.)
- **Limits:** ≤ 24 products, ≤ 8 locations per product, and ≤ 32 locations per file total
  (top-level `releases[]` plus every product's `releases[]` combined).
- **Don't over-declare identity.** `name`, `description`, `category`, `tags`, `avatar`,
  `social` shape how the org appears but are all optional — the locations are the point.
  Fill them only from facts you can confirm.
- **Domain scope is flat** — no `org` wrapper; the root object *is* the org. Only a domain
  file may use `products[]`, `name`, `avatar`, `tags`. Only a repo file may use `product`
  (singular) and `github: "self"`.
- **Taxonomy is advisory.** `category`, `kind`, `tags` are suggestions; unrecognized values
  are ignored by the registry, never an error. Don't agonize over exact values.

**Pinning (optional).** If the org/product is already in a registry and you want the file
bound to exact records instead of matched by URL, add a `registries` block. IDs live on the
org/product pages. The block is namespaced so other registries can coexist:

```json
"registries": { "releases.sh": { "org": "org_abc123" } }
```

(In a repo file, use `"product": "prd_…"` instead.) Unknown registries/keys are ignored.

## Step 4 — Validate locally

Run the bundled zero-dependency validator (Node 18+ or Bun, no install) — it checks the
full contract, including rules the plain JSON Schema can't express (at-least-one-locator,
at-most-one-canonical, the 32-total cap):

```bash
node <skill-dir>/scripts/validate.mjs path/to/releases.json
```

It auto-detects domain vs repo scope; pass `--scope domain|repo` to force it. A `✓` with
exit code 0 means valid; a `✗` lists every problem with a JSON path. Fix and re-run until
it passes. The canonical schema (kept in sync at
`https://releases.sh/schemas/releases.json`, snapshot at `references/schema.json`) is the
tie-breaker if anything is ambiguous.

Also confirm the file is syntactically clean JSON and, if you added `$schema`, that it points
at `https://releases.sh/schemas/releases.json`.

## Step 5 — Publish and confirm it's live

Serve the validated file at its scope's location:

- **Domain scope:** `https://{domain}/.well-known/releases.json`. Where the file goes in the
  repo depends on the framework — e.g. Next.js `public/.well-known/releases.json`, a static
  site's public root, or an app route that serves that exact path with
  `Content-Type: application/json`. Match how the project already serves `/.well-known/` or
  `robots.txt`.
- **Repo scope:** commit `releases.json` at the repository root.

After it's deployed and publicly reachable, confirm it end-to-end:

1. Fetch the live URL and check it returns HTTP 200 with valid JSON (no auth wall, no HTML
   redirect):
   ```bash
   curl -fsSL https://{domain}/.well-known/releases.json | node <skill-dir>/scripts/validate.mjs /dev/stdin
   ```
2. **Optional — ask releases.sh to validate the live domain** (no account needed; reads the
   file the same way the daily sweep will):
   ```bash
   curl -fsS -X POST https://api.releases.sh/v1/listing/validate \
     -H 'content-type: application/json' \
     -d '{"domain":"{domain}"}'
   ```
   The response previews the parsed identity, per-product location counts, and how each
   locator will be tiered. This is read-only — it does **not** create a listing.

Then stop. There's nothing else to run: the registry re-reads the file on a regular sweep,
so future edits are picked up automatically. Feeds/GitHub/App Store locations go live after a
quick automated check; plain web pages are reviewed by a person before any crawling starts.
The file is fill-if-empty and never overwrites curator decisions, so it's safe to leave in place.

## Updating an existing manifest

1. Read the current file and run it through `scripts/validate.mjs` first to see where it stands
   (it may predate a rule).
2. Re-verify that every already-declared location still responds; drop dead ones.
3. Add newly-found locations, keeping within the caps and the one-canonical rule.
4. If it's still a v1 file (`"version": 1` or profile-only fields like a nested `org`),
   **rewrite it to v2** — v1 is no longer read. Keep only what maps to the v2 shape above.
5. Validate again, then redeploy. No re-submission step is needed.

## Reference

- `references/schema.json` — the bundled JSON Schema snapshot (canonical:
  `https://releases.sh/schemas/releases.json`).
- `examples/` — minimal domain, full domain-with-products, and repo-root files.
- Owner-facing prose docs: `https://releases.sh/docs/listing`.
- To get an org into the registry in the first place (if it isn't listed yet), the owner can
  submit a changelog URL at `https://releases.sh/submit`, or the live-domain
  `POST /v1/listing/validate` → `activate` lane can create a listing from a published file.
