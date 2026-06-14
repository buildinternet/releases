---
name: managing-sources
description: How to create, delete, list, validate, and manage changelog sources — covers ignored/blocked URLs, duplicate detection, and the validation workflow
---

# Managing Sources

Operational guide for managing changelog sources.

## Tool Reference

Operations can be performed via CLI commands or typed MCP/agent tools. Use whichever interface is available in your context.

| Operation               | CLI                                                                                                                                 | Typed tool                                                                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List sources            | `releases list [slug] --json [--org <org>] [--query <text>] [--has-feed] [--category <c>] [--compact] [--limit <n>] [--page <n>]`   | `list_catalog` (scoped by organization) or `search` with `type: ["catalog"]` for query-style lookup                                                                                                                         |
| Create source           | `releases admin source create <name> --url <url> [--type <type>] [--org <org>] [--feed-url <url>] [--primary]`                      | `manage_source` action "add" with name, url, type, organization, feed_url, **is_primary** (type auto-detected if omitted; only pass is_primary=true when the source is the org's primary changelog — see "Primary Sources") |
| Create App Store source | `releases admin source create-appstore <url-or-id> [--platform ios\|macos] [--org <slug>] [--product <slug>] [--storefront <code>]` | _(no typed tool yet — CLI only)_                                                                                                                                                                                            |
| Update source           | `releases admin source update <identifier> [--primary] [--priority <p>]`                                                            | `manage_source` action "edit" with identifier, is_primary, fetch_priority, name, url, type (use only when changing an already-added source; prefer setting flags on "add")                                                  |
| Delete source           | `releases admin source delete <slug> [--ignore --reason <reason>]`                                                                  | `manage_source` action "remove" with identifier                                                                                                                                                                             |
| Fetch releases          | `releases admin source fetch <slug> [--dry-run] [--max <n>]`                                                                        | `manage_source` action "fetch" with identifier                                                                                                                                                                              |
| Get latest releases     | `releases tail [slug] --json [--org <org>]`                                                                                         | `get_latest_releases` with source, organization, limit params                                                                                                                                                               |
| Search releases         | `releases search <query> --json`                                                                                                    | `search` with `type: ["releases"]`, query, limit                                                                                                                                                                            |
| Evaluate URL            | `releases admin discovery evaluate <url> --json`                                                                                    | `evaluate_url` with url param (optional dry-run; `manage_source` action "add" auto-evaluates)                                                                                                                               |
| Create org              | `releases admin org create <name> [--domain <d>] [--description <t>] [--category <c>] [--tags <t1,t2>]`                             | `manage_org` action "add" with name, domain, description, category, tags                                                                                                                                                    |
| Update org              | `releases admin org update <slug> [--name <n>] [--domain <d>] [--tier <t>] [--billing-customer-id <id>]`                            | `manage_org` action "edit" with identifier, name, domain, description, category (`--tier` and `--billing-customer-id` are CLI-only; no typed-tool equivalent)                                                               |
| Get org                 | `releases admin org get <slug> --json`                                                                                              | `get_organization` with identifier                                                                                                                                                                                          |
| Add tags to org         | `releases admin org tag add <slug> <tags...>`                                                                                       | `manage_org` action "tag_add" with identifier, tags                                                                                                                                                                         |
| Link account            | `releases admin org link <slug> --platform <p> --handle <h>`                                                                        | `manage_org` action "link_account" with identifier, platform, handle                                                                                                                                                        |
| Create product          | `releases admin product create <name> --org <org> [--category <c>] [--tags <t>]`                                                    | `manage_product` action "add" with name, organization, category, tags                                                                                                                                                       |
| Ignore URL              | `releases admin policy ignore add --org <org> <url>`                                                                                | `exclude_url` action "ignore" with url, organization                                                                                                                                                                        |
| Block URL               | `releases admin policy block add <url>`                                                                                             | `exclude_url` action "block" with url                                                                                                                                                                                       |
| Get playbook            | `releases admin playbook <org>`                                                                                                     | `manage_playbook` action "get" with organization                                                                                                                                                                            |
| Update playbook notes   | `releases admin playbook <org> --notes-file <path>` (use `-` for stdin)                                                             | `manage_playbook` action "update_notes" with organization, notes                                                                                                                                                            |

Valid categories (pass to `manage_org`/`manage_product`): see the enum in those tool descriptions or your system prompt.

## Listing Sources

Search for existing sources with optional filters:

- **query** — filter by name, slug, or URL
- **organization** — filter by org ID or slug
- **product** — filter by product ID or slug
- **category** — filter by category
- **has_feed** — only sources with a discovered feed URL

Use `--json` (CLI) for structured output. Typed tools always return JSON.

## Adding Sources

Required: **name** and **url**. Optional: **type** (github, scrape, feed, agent — auto-detected from URL if omitted), **organization** (org ID or slug to associate with), **feed_url** (direct feed URL if known). App Store apps (`appstore` type) are **not** created this way — use `create-appstore` (below); `source create` rejects `--type appstore` and pasted `apps.apple.com` URLs with a pointer to it.

On slug collision the API auto-suffixes (`changelog` → `changelog-2`, `-3`, …) and the created row in the response tells you the resolved slug — no rename-and-retry needed.

### App Store sources

App Store apps need a dedicated command because the create flow resolves the iTunes listing, mints the current version as the first release, and backfills the product's avatar with the app icon. There is no typed-tool equivalent yet — this is CLI-only:

```
releases admin source create-appstore <url-or-id> [--platform ios|macos] [--org <slug>] [--product <slug>] [--storefront <code>]
```

- `<url-or-id>` accepts an `apps.apple.com/.../id<trackId>` URL, a bare numeric track ID, or an `appstore:<trackId>` coordinate. `--platform` defaults to `ios` (`macos` = Mac App Store); `--storefront` defaults to `us`.
- **Pre-create the product for a clean name.** With no `--product`, the endpoint names a _new_ product after the (often verbose) App Store title — e.g. "Shopify: Sell online/in person". To control the name, create the product first and reference it:

  ```
  releases admin product create "Shopify" --org shopify
  releases admin source create-appstore https://apps.apple.com/us/app/shopify/id719892358 --org shopify --product shopify
  ```

- **Keep writes serial.** The endpoint resolves the listing on the fly; concurrent creates for a brand-new org/product race on the org/product slug uniqueness constraint. Add one app at a time.
- The command is idempotent on the app's track ID — re-running reports the existing source instead of creating a duplicate.

### Naming sources and products

**Don't prefix names with the org name.** The org is already shown as context on every page — repeating it in each child source produces noise like "Datadog › Datadog dd-trace-py". Pick the bare, recognizable name instead.

Rules, in priority order:

1. **GitHub sources → use the repo name.** `DataDog/dd-trace-py` → `dd-trace-py`, `vercel/next.js` → `next.js`. That's the name devs already recognize; the `owner/repo` byline underneath disambiguates.
2. **Website/feed sources → strip the org name if present.** `Datadog Browser SDK` → `Browser SDK`, `Stripe API Changelog` → `API Changelog`.
3. **Keep the org prefix only when it's part of the canonical product name.** `Claude Code`, `GitHub Actions`, `Google Cloud Run`, `Amazon S3` — people say them that way. If you strip the prefix and what's left is the actual name people use, strip. If stripping produces something nobody would recognize on its own, keep the prefix.
4. **Org-level content sources keep the prefix.** `Datadog Blog`, `Vercel Engineering Blog` — "Blog" alone is meaningless, and org-prefix is the standard convention. Same for "Newsroom", "Announcements".
5. **Products follow the same rules.** A product under Vercel should be `Next.js`, not `Vercel Next.js`. A product under Datadog whose actual name is `Agent` stays `Agent` — the org context above it already says Datadog.

When in doubt: would a developer reading this name on its own (with the org already shown above) recognize what it is? If yes, strip. If no, keep the prefix.

### Grouping sources into products

**Grouping sources into products.** Most companies are single-product — leave `productSlug`/`productName` unset and sources attach directly to the org (the default).

Only when a company ships **2 or more genuinely distinct products** — each with its own identity and release cadence (Vercel → Next.js, Turborepo, SWR; Datadog → APM, RUM, Browser SDK) — tag each discovered source with the product it belongs to: `productName` (canonical name, same naming rules as sources — no org prefix) and `productSlug` (stable kebab-case, per-org unique).

A product is a distinct offering, **not**:

- the company/engineering blog, newsroom, or all-in-one changelog → leave org-direct (untagged)
- the docs site or marketing feed → org-direct
- every individual GitHub repo by default — only repos that are themselves a recognized product

If you can't name 2+ distinct products with confidence, tag nothing. Spurious products are worse than none.

### Organization descriptions

When creating an org, include a brief one-sentence product description. This grounds AI summaries for lesser-known products, and it's also the primary signal for the entity vector index — the `search` tool's catalog path matches on description + category, not just name. A good description noticeably improves recall.

### Embedding side effects

Adding or editing an org, product, or source triggers an entity embedding into the registry vector index in the background (fire-and-forget on the worker, never blocks the write). PATCHes are gated on the embed-relevant fields (name, description, category, domain, url) actually changing, so cosmetic edits and poll-driven metadata bumps don't re-embed. There's no manual step — if a write succeeds, treat the embedding as in-flight. If you ever need to verify or backfill, run `releases admin embed status` and then `releases admin embed entities` (remote mode only).

## Removing Sources

When removing discovery results, also ignore the URL to prevent re-discovery. In CLI: `releases admin source delete <slug> --ignore --reason "..."`. With typed tools: call `manage_source` action "remove" then `exclude_url` action "ignore".

## Ignored URLs (org-scoped)

A URL ignored for one org can still be valid for another org. Always scope ignores to the relevant organization.

## Blocked URLs (global)

For spam domains and known-bad URLs that should never be added for any org. Use block_type "domain" to block an entire domain.

## Validation Workflow

After adding a source, validate it:

1. **Add the source** — provide name and URL
2. **Fetch** — trigger a fetch (CLI: `--dry-run` for preview, then real fetch; typed tools: `manage_source` action "fetch")
3. **Check results** — get latest releases and verify they have titles, dates, content
4. **If bad:** remove the source and ignore the URL
5. **If good:** the source is ready for production fetches

## Primary Sources

An org can have one source marked as its **primary changelog** — the main, company-wide changelog.

`is_primary` is conditional, not default. Only set it when the source you are adding is clearly the org's primary changelog:

- Onboarding a new org with a single top-level changelog (e.g. `example.com/changelog`) — set `is_primary=true` on the add.
- Adding a supplementary or secondary source to an existing org (an engineering blog, a per-product changelog, an RSS feed alongside an already-primary page) — **do not** set `is_primary`. Leave the existing primary alone.
- The task prompt doesn't mention "primary" or similar — default to not setting it.

When it does apply, set it on the `add` call in one step, not via a follow-up edit:

```
manage_source(action="add", name="Changelog", url="https://example.com/changelog", organization="example-corp", is_primary=true)
```

The same applies on CLI: pass `--primary` to `releases admin source create`, not a follow-up `source update`.

Use `releases admin source create --primary` or `manage_source(action="add", ..., is_primary=true)` when adding the source in the current onboarding flow; reserve `releases admin source update --primary` or `manage_source(action="edit", is_primary=true)` for promoting a source that already existed before this session.

That promotion path is only for sources added in an earlier session — never in the same flow as the add.

## Playbooks

**A playbook is a per-org skill for fetching that org's releases.** Same mental model as the global skills in this corpus, scoped to one organization. Agents load the playbook into context alongside global skills whenever they fetch from this org — the playbook overrides general rules with the org's specific behavior (naming conventions, what counts as a release, cross-source dedup, rollup cadence).

Each playbook has two layers:

- **Header** — auto-generated from source metadata. Shows source types, URLs, priorities, parseInstructions, and product groupings. Regenerates automatically on every source mutation. You never edit this directly.
- **Agent notes** — free-form markdown that you fully control. This is the most important part of the playbook. Write it like a skill an agent will follow — imperative, action-oriented, concise — not like human documentation.

**Always read the playbook before fetching or working with an org's sources.** Typed tool: `manage_playbook` action "get" with organization param. CLI: `releases admin playbook <org>`. If no playbook exists yet, one will be auto-generated on the next source mutation (add/edit/remove).

### Writing good agent notes

The same rubric you would use to author any skill in this corpus applies here. A playbook is durable, instruction-shaped guidance for a future fetch agent that has never seen this org before. It is not a status report, not a bug log, not a record of what happened during onboarding.

#### Three layers — route facts to the right home

Three different shapes of information end up needing a home during onboarding and fetching. Each has its own destination. Routing facts to the wrong one is the most common authoring mistake.

| Shape of fact                                                                                                                                                                                                                         | Home                                                                                                                                                 | Read by                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Target-shaped, durable, org-specific (DOM hooks, IP blocks, repo splits, monorepo patterns, version format, scope decisions).                                                                                                         | **Playbook** — `manage_playbook(action=update_notes)`.                                                                                               | Every future fetch agent for this org.                       |
| Org-specific raw observation, possibly noisy or single-session (a redirect chain you saw, a candidate URL you probed, a quirk you suspect but haven't confirmed).                                                                     | **`releases-errata` memory store**, `/orgs/<org_id>/observations.md` for resolved orgs, `/discovery/global.md` for cross-org / pre-resolution notes. | Future discovery and fetch agents in managed-agent sessions. |
| Harness-shaped or adapter-shaped — any fact that's true about _our_ code, MCP tool, or fetcher rather than the target. ("Adapter X errors with Y", "MCP tool Z arrived as custom_tool_use", "fetch returns 0 even with feedUrl set"). | **`releases-tool-notes` memory store**, `/tools/<tool>.md`, `/mcp/<server>/<tool>.md`, `/harness/notes.md`.                                          | Future managed-agent sessions across all orgs.               |

If you have memory stores attached, log to the right store and **leave the playbook out of it**. If you don't (e.g. local Claude Code sub-agents), drop facts that don't pass the playbook keep test — don't relocate them into the playbook just because there's nowhere else to put them.

#### The keep test

Before you write a sentence in the playbook, ask: **would a brand-new fetch agent six months from now, fetching this org from a clean harness, still need this fact?**

If yes — keep it. If no — drop it (or, in a managed-agent session, route it to errata or tool-notes).

| Keep                                                                                                                           | Drop                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Network or platform behavior of the target (IP blocks, geo gates, auth walls).                                                 | Transient errors that happened during onboarding.                                                                                              |
| Page-structure facts the parser needs (DOM hooks, version-keyed headings, date format).                                        | Symptoms of bugs in our adapters or harness ("returns 'Missing feedUrl in metadata' even though it's set"). Those go to `releases-tool-notes`. |
| Site-wide vs scoped feed gotchas (the `<link rel="alternate">` resolves to the wrong feed; force a specific URL and feedType). | Notes that pause a source pending an internal fix ("Re-evaluate after harness fix", "Do not re-enable until X is investigated").               |
| Org / repo naming history and split (`googleapis` vs `google-gemini`, deprecated mirror repos).                                | Anything phrased as a follow-up engineering task.                                                                                              |
| Monorepo / per-package release-tag patterns; what the real artifact is (CHANGELOG.md vs Releases).                             | Speculation about why something failed if you have no evidence.                                                                                |
| Pre-release / nightly tag noise that's expected and ongoing.                                                                   | Self-reporting that the agent should "investigate" or "look into" something later.                                                             |
| Scope decisions: which sources are canonical, which siblings to skip and why (mirror site, marketing blog, archived repo).     | Restating what's already in the auto-generated header (source list, last-fetched dates).                                                       |
| Cadence and content depth as observed signals (cite real examples).                                                            | Cadence claims with no observed basis ("probably ships weekly").                                                                               |

Do not direct the agent to file issues, write to a notes field elsewhere, or trigger any follow-up engineering process from inside the playbook. Issue tracking is a separate, human concern. Agents do not self-report engineering work in the body.

#### Sections

The body has three sections, in order. Use these exact headings — no fourth section, no renamed headings.

**`### Fetch instructions`** — One short paragraph per active source. Imperative voice. Tell the next agent what to do and what to expect:

- What the source is (one phrase).
- The artifact that matters (tagged releases, CHANGELOG.md, scrape DOM hook, scoped RSS).
- Version format with one real example from observed data.
- Cadence as observed (cite a real number — "100 releases since 2025-09" beats "active").
- Any per-source flag that's already set or should stay set (`renderRequired: false`, crawl mode, paused).

If a source is paused, say why in target-specific terms ("archived and superseded by X", "low star count, lower than the canonical Y SDK"). Do **not** say "paused pending bug fix" — that's a tool-notes concern, not a playbook fact.

If the org publishes seasonal, quarterly, or annual **rollup** pages instead of incremental entries (Shopify Editions, Brex Fall Release, Ramp quarterly blog), say so here and tell the parser to classify matching pages as `type: rollup`. Example: _"Ramp publishes quarterly rollups at `/blog/new-on-ramp-q*-*` and monthly editions at `/blog/new-on-ramp-*-edition`. Classify all entries from this source as `type: rollup`."_ The `parsing-changelogs` skill ("Classifying Rollups" section) covers what rollups look like; the playbook captures the org-specific signal.

Skip purely-restated metadata. The reader can already see the URL and type in the auto-generated header.

**`### Traps`** — Bullet list. Each bullet starts with a **bolded trigger label** describing the situation, then a short imperative explaining what to do.

Only include traps that pass the keep test. Good traps name a property of the **target** that would cause a future fetch to do the wrong thing:

- **Site-wide feed hijack:** the `<link rel="alternate">` on every doc page resolves to the global blog feed. Set `feedUrl` explicitly to the section `index.xml` and force `feedType=atom`.
- **Per-package release tags:** the GitHub Releases API returns thousands of stale per-package pre-releases. Use the root CHANGELOG.md as the primary artifact instead of tags.
- **Provider IP block:** the SSR page is parseable in a browser but our fetcher's egress IPs are blocked. Leave at normal priority — the underlying URL is still correct.
- **Deprecated mirror repo:** `org/foo-deprecated` is archived; the canonical repo lives at `org/foo`. Don't re-add the mirror.
- **Doubled paths on Platform:** relative doc links get prefixed with the source URL, producing doubled paths. Strip the prefix before recording.
- **Don't re-discover:** include disabled sources with this label so future runs don't re-evaluate them.

Do not include adapter or harness bugs ("feed returns 'Missing feedType in metadata'") — route to `releases-tool-notes`. Do not include onboarding-time errors not tied to a target property. Do not include future engineering work the agent thinks should happen.

**`### Coverage`** — Two to four sentences. Which sources are canonical, what's covered, what's intentionally skipped (with a one-clause reason — "blog feed is site-wide marketing", "mobile SDKs live under a different org"). Optionally a short cadence summary if it varies meaningfully across sources.

Do **not** list "missing" sources as a to-do. If a surface isn't worth tracking, say it's out of scope and why. If a surface is worth tracking but doesn't exist yet ("API changelog is currently a 404"), one sentence noting that the URL was probed and what the next agent should re-check is fine.

#### Voice

- Imperative. "Set version=null", "Parse `<h2>` as version boundaries", "Skip nightly tags". Not "we should…" or "the agent could…".
- Concrete examples from real data, not invented ones.
- No first-person plural. No narration of the onboarding session.
- No timestamps inside the body — "as of May 2026", "this morning", "during onboarding". The header carries time. Body content is meant to be true on every future read.
- No references to internal team process — issue numbers, ticket IDs, "the team will fix this", "see issue #N". The playbook is an LLM-facing skill, not a project board.

#### When the truth is "we don't know yet"

It's fine to write a short trap that records a real, durable target property even if you couldn't fully exploit it during onboarding — for example, "the API changelog is a static HTML page with no feed; rely on scrape" or "developer changelog URL returned 404 — re-check on next visit." That's target-shaped.

It is **not** fine to write "fetch returned an error during onboarding so we paused it." That's session-shaped and adapter-shaped. If a source is failing for reasons you can't attribute to the target, pause the source without an explanation in the playbook body — the source's own state already records that it's paused. In a managed-agent session, log the underlying tool error to `releases-tool-notes`.

#### Reading first

Always call `manage_playbook(action=get)` before writing. Preserve durable trap entries from prior runs. If you're rewriting a section, fold prior facts that still pass the keep test into the new draft instead of dropping them.

In a managed-agent session, also read `releases-errata` `/orgs/<org_id>/observations.md` (and `/discovery/global.md` if it predates the org being resolved) before writing. Some of those observations may have stabilized into facts worth promoting into the playbook; others are still hints and stay in errata.

### Levels of playbook quality

**Compilation** (fast, from metadata only): Write notes based on source metadata — URL, type, priority, parseInstructions. Good for bulk coverage but claims about page structure, cadence, and version format are inferred, not verified. Suitable for initial scaffolding or low-priority orgs.

**Verified** (thorough, from actual data): Before writing, query release data and fetch logs to ground every claim in observation:

1. `releases list <slug> --json` — Check actual version formats, titles, content length, publishedAt patterns
2. `releases admin source fetch-log <slug> --json` — Check for errors, success rates, stale data
3. Compare `lastFetchedAt` to the cadence you measure in step 1. **An empty fetch-log is not the same as "ingested successfully".** If `lastFetchedAt` is older than ~3× the typical interval between releases (e.g. last fetch was 5 weeks ago for a weekly source), the cron is no-op'ing this source. The likely cause: the `changeDetector` is `unreliable` and nothing else is flagging the source. Don't rubber-stamp it as healthy — surface this to the human operator, or (if you authored the `unreliable` quirk yourself) reconsider whether a more targeted detector would work, e.g. `body-hash-filtered` for SSR pages whose raw body churns but article markup is stable, or `body-hash` against a CSS-selector slice in a future revision.
4. Analyze: calculate real cadence from dates, identify empty content or null fields, spot date drift
5. Write notes citing specific data points, not general assumptions

Use the verified approach for high-value orgs, when onboarding new orgs with scrape sources, or when refreshing stale compilation-only playbooks. The difference: "this source likely needs JS rendering" (compilation) vs "all 50 releases have empty content — the RSS feed delivers summaries only, needs crawl mode on per-release pages" (verified).

Write notes during onboarding after you've fetched and validated sources. Update them when you discover new quirks or when source behavior changes. If notes are empty or stale, write them before doing fetch work — future agents (including yourself in later sessions) will benefit.

**Updating notes:** Use `manage_playbook` action "update_notes" with the complete notes content — it replaces the entire notes section. You can rewrite, reorganize, or clear notes at any time.

**Frontmatter (typed config):** If the existing notes begin with a YAML frontmatter fence (`---` lines at the very top), preserve that block verbatim when you update. It carries typed configuration that cron code reads directly — e.g. `fetchQuirks` per-source change-detector hints. Write your markdown _below_ the closing `---`. Example:

```markdown
---
fetchQuirks:
  brex:
    changeDetector: etag
    rationale: ETag stable across HEADs
---

### Fetch instructions

(your prose notes here)
```

Only edit the fence when a source's fetch behavior genuinely changes (e.g. you verified a new ETag stability, or the site switched to SSR). Valid `changeDetector` values: `etag`, `content-length`, `body-hash`, `body-hash-filtered`, `unreliable`. Optional keys: `tier` (`normal` | `low`), `changeProbeUrl` (alternate HEAD target).

Pick `body-hash-filtered` when the page is SSR (Next.js / Vercel / Astro) and the raw body hash churns per-request (hydration tokens, chunk URLs, nonces) but the article markup is stable. The detector strips `<script>`, `<style>`, `<link>`, `<meta>`, and HTML comments before hashing. If `body-hash` already works, leave it — `body-hash-filtered` is for cases that would otherwise be tagged `unreliable` and lean on the daily force-drain cron.

**Changing source configuration:** The header reflects current source metadata. To change things like `parseInstructions`, `fetchPriority`, or `crawlEnabled`, use `manage_source` action "edit" with metadata — the header updates automatically.

**Product context:** Playbooks group sources by product when products are configured. Some sources (like an org's engineering blog) aren't tied to a specific product but may contain content relevant to any product under that org — the playbook calls these out as "Organization-Level Sources" with a note about which products they may cover.

## Rendering Control

The scrape adapter can fetch pages with or without a headless browser. Static-site providers (Docusaurus, VitePress, WordPress, Ghost, Mintlify) are fetched without rendering by default — this is ~10-30x faster.

To override the default for a specific source:

- `releases admin source update <identifier> --no-render` — force fast fetch (no headless browser)
- `releases admin source update <identifier> --render` — force headless browser rendering

Use `--render` when you know a source needs JavaScript execution. Use `--no-render` when you've verified the content is in the initial HTML for a provider not yet in the static list.

After adding a new scrape source with an unknown provider, check the first fetch results. If content is complete, consider setting `--no-render` and noting the provider behavior in the playbook.

**Blocked by a Cloudflare Managed Challenge?** `--render`/`--no-render` only choose _how_ we fetch — they don't help when the page returns a bot challenge that fails browser rendering itself (symptom: persistent `no_change` / 0 releases on a page that clearly updates, e.g. some vendor help pages). For those, the external **Firecrawl monitoring** backend can fetch the page instead. It's enabled per source via the admin API (`POST /v1/sources/:slug/firecrawl/sync { enabled: true }`), backend-only — not via a metadata edit (which skips monitor creation). See `docs/architecture/firecrawl-monitoring.md`.

## On-Demand Sources

The on-demand lookup endpoint (`POST /v1/lookups`) can materialize a hidden source row for any `{org}/{repo}` GitHub coordinate a user searches for. These rows carry `discovery = 'on_demand'` and `isHidden = true`. They fold into the normal cron fetch at `low` priority but skip AI features (overviews, summarization, playbook regen).

If you encounter a source with `discovery = 'on_demand'` during an agent task:

- Do not re-add it — it already exists (you'd get a slug collision).
- To promote it to a fully indexed curated source: `manage_source` action "edit" with `discovery: 'curated'` and flip `isHidden` to false. Also edit the name if it was auto-generated from the coordinate.
- The org created alongside the source may also be `discovery = 'on_demand'`. Promote it with `manage_org` action "edit" with `discovery: 'curated'`.

## Duplicate Detection

Before adding sources, search for overlapping URLs.

Common duplicates:

- Same repo via GitHub URL vs changelog page (the GitHub source is usually better)
- RSS feed URL vs the page it feeds from (keep the feed)
- With and without trailing slash or `www.` prefix
