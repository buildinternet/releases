# Classification taxonomy

Several independent axes classify orgs, products, sources, and releases. They are deliberately orthogonal and have collided on naming before, so this doc is the canonical reference for what each axis means and how they differ.

## The axes at a glance

| Axis                  | Applies to        | Stored as                 | Owns "what it IS" / "what it's about" / "how grouped"                    | Canonical home                               |
| --------------------- | ----------------- | ------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| `kind`                | products, sources | enum (nullable)           | what the row **is** (platform, sdk, mobile, …)                           | this doc                                     |
| `type` (source)       | sources           | enum                      | how the row is **fetched** (`github`/`scrape`/`feed`/`agent`/`appstore`) | AGENTS.md → Conventions                      |
| `category`            | orgs, products    | slug (validated)          | which **industry vertical** it serves                                    | [web.md → Category metadata overlay](web.md) |
| `tags`                | orgs, products    | freeform join rows        | ad-hoc labels                                                            | this doc                                     |
| `release type`        | releases          | enum (`feature`/`rollup`) | shape of a single release                                                | this doc                                     |
| product grouping      | sources           | nullable `productId`      | optional org→product→source nesting                                      | this doc                                     |
| collection membership | orgs              | join rows                 | curated cross-org playlists                                              | [web.md → Collections](web.md)               |

The naming of `kind` was chosen specifically to avoid these collisions: `type` already names the fetch adapter on `sources`, and `category` already names the industry-vertical taxonomy. A future cleanup may rename `sources.type → sources.adapter` and promote `kind → type` — out of scope for now.

## Source `kind`

`kind` classifies what a row IS, independent of how it's fetched (`type`) or what industry it serves (`category`). Values: `platform | sdk | mobile | desktop | docs | integration | tool`, defined in `@buildinternet/releases-core/kinds`. Nullable on both `products` and `sources`.

- `kind=mobile` means an **App Store app**, not a mobile SDK. iOS/Android client libraries are `sdk`; `mobile` is reserved for store apps (e.g. `claude-ios`).

**Resolution rule:** `source.kind` wins; if null, inherit from the parent product via `resolveSourceKind`.

**Filter asymmetry** — content surfaces apply inheritance, catalog surfaces match the row's own value:

- **Content (COALESCE inheritance):** the releases feed (`/v1/orgs/:slug/releases?kind=`) and `/v1/search` release hits — "give me all the SDK _content_". MCP mirrors: `search` and `get_latest_releases` apply inheritance.
- **Catalog (own `kind` only):** `/v1/sources`, `/v1/products`, `/v1/orgs/:slug/catalog`, and `/v1/search` catalog hits — "give me rows classified as X". MCP mirrors: `list_catalog` matches the row's own `kind`.

The `search` tool echoes the applied `kind` (and `type` section) filter back on `_meta.search`. CLI write support (`admin source/product update --kind`, list/search filters) lives in the OSS CLI.

## Products

Products are an **optional** grouping layer between orgs and sources (nullable `productId`). Multi-product orgs (e.g. Vercel → Next.js, Turborepo) use them; simple orgs skip the layer. Once an org has 2+ products, the product becomes the primary UI unit — see [web.md → Product-first URL resolution](web.md).

## Release type

A release is `feature` (default) or `rollup` (a seasonal/quarterly catch-all). The parse agent classifies it via the `parsing-changelogs` skill. Consumers:

- `get_latest_releases` accepts a `type` filter.
- The unified `search` tool (#539) takes `type: ("orgs"|"catalog"|"releases")[]` to narrow which sections it returns (this is the _section_ selector, a different `type` from release type), plus `mode: "lexical"|"semantic"|"hybrid"`. Release hits carry a `kind: "release"|"changelog_chunk"` discriminator on the wire.

See [semantic-search.md](semantic-search.md) and [mcp.md](mcp.md).

## Tags

Tags are freeform (get-or-create via the `tags` table). Join tables are `org_tags` and `product_tags`. Unlike `category`, there is no validation list — any string becomes a tag on first use.

## Categories (summary — canonical detail in web.md)

Categories are validated against `CATEGORIES` in `@buildinternet/releases-core/categories`; adding one requires a code change. The `categories` table is an optional editable overlay (per-slug `name` override, `description`, and `aliases` that 301-redirect to canonical). Write paths normalize input via `resolveCategoryInput()` (so `"e-commerce"` lands as `"commerce"`). Full overlay + alias-uniqueness mechanics: [web.md → Category metadata overlay](web.md).

## Collections (summary — canonical detail in web.md)

Collections (#812, #813) are curated, named org playlists independent of `category`. Schema: `collections` (slug-keyed) + `collection_members` (`collection_id`, `org_id`, `position`). Member orgs join through `organizations_public`, so soft-deleted / `on_demand` orgs never leak. Read surface `/v1/collections{,/:slug,/:slug/releases}` is a cursor-paginated cross-org feed matching the org-feed ordering/cursor shape. Full write semantics + web surface: [web.md → Collections](web.md).
