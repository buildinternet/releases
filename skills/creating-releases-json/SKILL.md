---
name: creating-releases-json
description: >-
  Create or update a releases.json manifest so registries and agents can find
  where a company or project publishes its release notes. Use this whenever
  someone wants to "list our product on Releases", "add a releases.json", "get
  indexed on releases.sh", "here's our website, make us a manifest", declare a
  changelog / updates page / RSS feed / GitHub releases / App Store listing /
  CHANGELOG for discovery, publish a /.well-known/releases.json, or edit an
  existing one — even if they don't say "releases.json" by name. The usual input
  is just a company website or domain (no codebase required); the manifest is a
  small, schema-validated file the owner hosts on their domain or repo. This
  skill discovers the real publish locations, models products without
  over-fragmenting, writes the correctly-scoped file, validates it locally, and
  guides publishing it.
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
where release notes **actually** live (never invent them), model the company's
products without over-fragmenting, write a correctly-shaped file, validate it, and
help get it published.

## How you'll be asked to run this

Most of the time there is **no codebase** — someone just says *"here's our website,
make us a releases.json"*. That's the primary path: you work from the live site (and
GitHub org), browsing to find where updates are published, and you hand back a finished
file plus instructions on where to host it. You cannot commit it for them.

Less often you're working **inside a repo** — the one that serves the company's site, or
a single product/library repo — in which case you can also read the codebase and write
the file into place. Both paths use the same steps below; only Step 1 (scope) and Step 5
(publish) differ.

## The one rule that matters most

**Only declare locations that really exist and respond.** The manifest states plain
facts about where updates are published. A guessed or aspirational URL is worse than
omitting it — it creates a broken source. Before writing any locator, confirm the URL
resolves (fetch it, or check it against the codebase/site). If you cannot verify a
location, leave it out and say so.

## Step 1 — Choose the scope

There are two scopes. They share one schema but declare different things:

| Scope      | Lives at                                                 | Declares                                                    |
| ---------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| **Domain** | `https://{domain}/.well-known/releases.json`             | Company identity, `products[]`, and top-level `releases[]`  |
| **Repo**   | `releases.json` at a repository root                     | A `product` binding + where **this repo's** releases land   |

**Default to domain scope** — it's what "here's our website, make us a manifest" wants, and
it's the only scope that can describe the whole company and multiple products. Choose repo
scope only when you're clearly operating inside one product/library repo and the goal is to
bind *that repo* to a product. A repo file **cannot** declare company identity; a domain
file cannot speak for a repo it doesn't host. If genuinely unsure, ask which one they want.

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

## Step 2b — Model products correctly (don't over-fragment)

This is where agents most often go wrong. **`products[]` is optional, and a manifest with
just a top-level `releases[]` is often the *right* answer.** Only reach for `products[]`
when the company genuinely ships multiple things that publish releases in *different*
places. The test for whether something deserves its own product entry is simple:

> **Does it have its own release location?** A product earns an entry only if it has a
> release stream distinct from the company changelog — its own repo, its own feed, its own
> changelog page, or its own App Store listing.

Marketing structure is **not** release structure. Companies segment their site into
"capabilities", "solutions", or "modules" for buyers; that segmentation almost never maps
to distinct release feeds. Follow where the *releases* are published, not how the *site*
is organized.

**Two anti-patterns to actively avoid:**

- **One product per marketing capability, all pointing at the same changelog.** If you find
  yourself writing eight products — "Analytics", "Session Replay", "Experiment", …— that all
  carry the identical `url`/`feed`, stop. Those aren't eight products; they're one company
  with one changelog. Declare it once in the top-level `releases[]` and drop the redundant
  product entries. Duplicated locators just dedup back to one source and add noise.
- **One product per language SDK.** A company with client libraries in Python, JS, Swift,
  Kotlin, Go, … has **one** developer/SDK offering, not one product per language. Bundle
  the libraries as multiple `github` locators under a single product (e.g. `"API & SDKs"` or
  `"SDKs"`), mark the primary/most-active one `canonical`. If there are more than 8 repos
  (the per-product cap), list the most active or the monorepo — don't spill into extra
  products to fit them all.

**When separate products *are* right:** each has its own release location. Vercel is the
model — Next.js (`github: vercel/next.js`), Turborepo (`vercel/turborepo`), the AI SDK
(`vercel/ai`), and v0 (`v0.app/changelog`) each publish releases independently, so each is
a real product entry with its own `canonical` locator.

**Rule of thumb:** if every product entry you're about to write shares one changelog, you
want zero products and one top-level `releases[]`. Add products only for the pieces that
break out into their own release stream.

For worked before/after examples of all three cases, see `references/modeling-products.md`.

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
- **Products carry a fixed, small set of fields** and nothing else — the schema is strict and
  rejects unknown keys. A product may have: `name` (required), `slug`, `kind`, `category`,
  `description`, `website`, `docs`, `support`, `social`, `archived`, `releases`. In
  particular **`tags` is an org-level field only — products have no `tags`** (a common
  mistake that fails validation). Put company-wide tags at the root, not on products.
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

**If you don't have the repo** (the common "here's our website" case), you can't publish it
for them — hand back the finished file and tell them exactly where it goes:

- Save the file where they can grab it and tell them its target URL:
  `https://{domain}/.well-known/releases.json`.
- Explain the one requirement: it must be served at that exact path, over HTTPS, with
  `Content-Type: application/json` and no auth wall or redirect. How they do that depends on
  their host (a `public/.well-known/` directory for most static/Next.js sites, an app route,
  or their CDN's static-file rules — the same mechanism that serves their `robots.txt`).
- Then Step 2 of the confirmation below is something *they* run after deploying.

**If you do have the repo,** write it into place:

- **Domain scope:** wherever that project serves `/.well-known/` — e.g. Next.js
  `public/.well-known/releases.json`, a static site's public root, or an app route serving
  that exact path. Match how it already serves `robots.txt`.
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

- `references/modeling-products.md` — worked good/bad examples of the product-modeling rules
  in Step 2b (capability sprawl, one-product-per-SDK, and when separate products are right).
  Read it when a company has many offerings and you're unsure how to split them.
- `references/schema.json` — the bundled JSON Schema snapshot (canonical:
  `https://releases.sh/schemas/releases.json`).
- `examples/` — minimal domain, full domain-with-products, and repo-root files.
- Owner-facing prose docs: `https://releases.sh/docs/listing` (fuller narrative + a
  copy-paste agent prompt; this skill is the operational version of that guidance).
- To get an org into the registry in the first place (if it isn't listed yet), the owner can
  submit a changelog URL at `https://releases.sh/submit`, or the live-domain
  `POST /v1/listing/validate` → `activate` lane can create a listing from a published file.
