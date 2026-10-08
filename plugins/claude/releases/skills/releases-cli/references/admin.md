# Admin Commands

> **Closed beta.** All commands on this page require `RELEASES_API_KEY` — a Bearer token on write endpoints of `api.releases.sh`. API keys are **not self-serve** at this time. A normal user cannot create one on their own, and the hosted registry does not expose a public signup flow for admin access. If a user asks how to obtain a key, tell them admin access is currently invite-only and point them at the project repo to request access. Do not fabricate a signup URL or recommend sending a request to a specific email unless one is documented in this repo.

If a key is available, set it in the environment:

```bash
export RELEASES_API_KEY=your_key
```

Missing or invalid keys fail fast at CLI startup with a clear error; don't retry the same command without fixing the env var.

All admin commands accept an entity ID (`org_…`, `src_…`, `prod_…`, `rel_…`) or a slug wherever an identifier is expected. Source and product commands also accept an `org/slug` coordinate (e.g. `vercel/vercel-ai-sdk`). Prefer IDs or coordinates — slugs can change, IDs cannot, and coordinates typically skip an extra resolver round-trip that bare slugs require under the hood (#698).

## Previewing changes (`--dry-run`)

Most mutating admin verbs accept `--dry-run`. The command resolves identifiers, runs validation (category, URL exclusion, existing-record dedup, etc.), and prints the planned write without calling the API. Pair with `--json` for a machine-readable plan.

Coverage:

- **source**: `create`, `update`, `delete`, `import`
- **org**: `create`, `update`, `delete`, `link`, `unlink`
- **product**: `create`, `update`, `delete`, `adopt`
- **release**: `update`, `delete`, `suppress`, `unsuppress`
- **policy**: `ignore add`, `block add`
- **embed**: write paths
- **recommendations**: `notify-added`

Tag and alias `add` / `remove` on org/product are intentionally left without a preview — they're trivially reversible joins.

## Sources

### Create

```bash
releases admin source create "Next.js" --url https://github.com/vercel/next.js
releases admin source create "Linear" --url https://linear.app/changelog
releases admin source create "My Blog" --url https://example.com/changelog
releases admin source create "Linear" --url https://linear.app/changelog --dry-run --json
```

`--dry-run` still runs the URL dedup and exclusion checks (so you'll see "already exists" or "blocked URL" outcomes), but skips the write — including the auto-create-org side effect when `--org <name>` doesn't resolve.

By default, `create` runs automated pre-checks (provider detection, feed discovery, markdown probing). Override with `--type github|scrape|feed|agent`. Batch mode (`--batch`) skips evaluation by default for speed. App Store apps use the dedicated `source create-appstore` verb (below) — `create` rejects `--type appstore` and pasted `apps.apple.com` URLs with a pointer to it. YouTube channels/playlists use `source create-video` (below) — `create` likewise rejects `--type video` and pasted `youtube.com`/`youtu.be` URLs.

Provide a feed URL explicitly when it isn't easily discoverable:

```bash
releases admin source create "Claude Code" --url https://docs.anthropic.com/en/changelog \
  --feed-url https://docs.anthropic.com/en/changelog/rss.xml
```

Set source metadata **at create time** with `--keyword-allow` (feed keyword filter → `metadata.feedKeywordAllow`) or the general `--metadata-set key=value` (repeatable; same coercion as `source update --metadata-set`):

```bash
releases admin source create "Discord" --url https://discord.com/blog --type feed \
  --feed-url https://discord.com/blog/rss.xml --keyword-allow changelog,patch-notes
releases admin source create "Acme" --url https://acme.dev/changelog \
  --metadata-set marketingFilter=true --metadata-set feedContentDepth=summary-only
```

Do this rather than a follow-up `source update --metadata-set`: `create` triggers the onboard workflow's auto-fetch, which reads the source's metadata **before** any post-create edit lands. Setting a feed filter on create keeps that first ingest filtered; setting it afterward races the auto-fetch and ingests the whole unfiltered feed.

Mark the org's primary changelog in one step with `--primary` (sets `isPrimary` on create — no follow-up `source update --primary` needed). Only pass it when the source is the org's main, company-wide changelog:

```bash
releases admin source create "Vitest" --url https://github.com/vitest-dev/vitest --org vitest --primary
```

#### Raw JSON payload (`--input`)

Instead of reverse-mapping a payload onto individual flags, send one source as a JSON body with `--input`. The body mirrors the `--batch` element shape (`name`, `url`, `type`, `slug`, `org`, `product`, `feedUrl`, `keywordAllow`, `metadataSet`, `primary`) and runs the same dedup / metadata-packing / validation as the flag path — it is **not** forwarded raw to the API. Pass a literal JSON string, `@<path>` for a file, or `-` for stdin; `--strict`/`--dry-run`/`--json` still apply. Mutually exclusive with `--batch` (use `--batch` for an array).

```bash
releases admin source create --input '{"name":"Astro","url":"https://astro.build/blog","type":"scrape"}'
releases admin source create --input @source.json
echo '{"name":"Astro","url":"https://astro.build/blog"}' | releases admin source create --input -
```

Evaluate without adding:

```bash
releases admin discovery evaluate https://linear.app/changelog
```

### Create App Store

App Store apps have a dedicated verb because the create flow resolves the iTunes listing, mints the current version as the first release, and backfills the product's avatar with the app icon:

```bash
releases admin source create-appstore https://apps.apple.com/us/app/slack/id618783545 --org slack --product slack
releases admin source create-appstore appstore:618783545 --platform ios --org slack
releases admin source create-appstore 1496833156 --platform macos --dry-run
```

The identifier is an `apps.apple.com/.../id<trackId>` URL, a bare numeric track ID, or an `appstore:<trackId>` coordinate. `--platform` defaults to `ios` (`macos` = Mac App Store); `--storefront` defaults to `us`. The verb is idempotent on the track ID — re-running reports the existing source.

With no `--product`, the endpoint names a _new_ product after the (often verbose) App Store title — e.g. "Shopify: Sell online/in person". To control the name, create the product first and reference it with `--product`:

```bash
releases admin product create "Shopify" --org shopify
releases admin source create-appstore https://apps.apple.com/us/app/shopify/id719892358 --org shopify --product shopify
```

Add one app at a time — the listing is resolved on the fly, and concurrent creates for a brand-new org/product race on slug uniqueness.

### Create Video

YouTube channels and playlists have a dedicated verb because the create flow resolves the channel/playlist to its Atom feed, mints a `video` source, and backfills current videos as releases (description-only, summarizer-cleaned, marketing-filtered):

```bash
releases admin source create-video https://www.youtube.com/@AnthropicAI --org anthropic
releases admin source create-video https://www.youtube.com/playlist?list=PLf2m23nhTg1P --org anthropic --product claude
releases admin source create-video https://www.youtube.com/@AnthropicAI --org anthropic --dry-run
```

`--org` is **required** and must already exist — unlike `create-appstore`, no org is derived from the channel. Pass a slug or a typed `org_…` id. `--product <slug>` (optional) attaches the source to an existing product. The verb is idempotent on the resolved feed URL — re-running reports the existing source.

Do not point generic `source create` at a YouTube URL. It builds a `feed` source whose parser drops `media:group/media:description`, producing a source with titles and dates but **empty release bodies** — a silent failure. `create` rejects `--type video` and pasted `youtube.com`/`youtu.be` URLs with a pointer to this verb.

### Update

```bash
releases admin source update src_abc123 --name "New Name"      # by ID (preferred)
releases admin source update next-js --url https://github.com/vercel/next.js/releases
releases admin source update my-blog --org acme                 # set organization
releases admin source update my-blog --no-org                   # remove organization
releases admin source update my-blog --type feed                # change adapter type
releases admin source update my-blog --no-feed-url              # clear stored feed URL
releases admin source update my-blog --markdown-url https://example.com/changelog.md
releases admin source update my-blog --primary                  # mark as org's primary changelog
releases admin source update my-blog --kind sdk                 # classify (platform|sdk|mobile|desktop|docs|integration|tool)
releases admin source update my-blog --no-kind                  # clear; falls back to parent product's kind
releases admin source update my-blog --slug new-slug --confirm-slug-change
```

Slug renames require `--confirm-slug-change` because they break existing web links.

Send a batch of field updates as one JSON body with `--input` instead of stacking flags. Keys mirror the flags (`name`, `url`, `type`, `org`, `product`, `kind`, `priority`, `discovery`, `primary`, …); a nested `metadata` object sets source-metadata keys directly (a `null` value deletes a key — the ergonomic equivalent of repeated `--metadata-set`/`--metadata-unset`). Accepts a literal JSON string, `@<path>`, or `-` for stdin. The body wins over any flags; `--json`/`--dry-run` still apply.

```bash
releases admin source update src_abc123 --input '{"kind":"sdk","priority":"low","metadata":{"crawlEnabled":true}}'
releases admin source update src_abc123 --input @patch.json
```

`--kind` sets the source's taxonomy. In **release feeds** and **search release hits**, a source with no kind of its own inherits its parent product's kind — so filtering by `kind=sdk` returns content from any source that's either marked SDK or sits under an SDK product. In **catalog listings** and **source lists** (`releases list`, `admin product list`, `search` catalog hits), the filter matches the row's *own* kind field directly with no inheritance — so the same `kind=sdk` filter only returns rows explicitly classified as SDK.

### Fetch

```bash
releases admin source fetch next-js              # one source (slug, src_… id, or org/slug)
releases admin source fetch --org acme           # all of an org's active sources
releases admin source fetch --stale 24           # only stale sources, with backoff
releases admin source fetch --retry-errors       # retry sources whose last fetch failed
releases admin source fetch --changed            # sources with upstream changes detected
releases admin source fetch --unfetched          # never-fetched sources
releases admin source fetch next-js --wait       # block until the dispatched session finishes
releases admin source fetch next-js --dry-run    # probe without writing or billing
releases admin source fetch next-js --local      # stage a local-ingest handoff (no managed agent)
```

Notes:

- The server caps each fetch at 200 releases per source (GitHub paginates at ~10K); there is no CLI override flag.
- A fetch that inserts new releases also triggers a server-side fill pass over the source's missing AI titles/summaries (up to 100 rows) when the org has `auto_generate_content` enabled — no flag, no second step.
- Remote mode **requires** a filter or slug. Bare `releases admin source fetch` with no args is blocked to prevent accidental bulk work.
- A source identifier can't be combined with `--org` — pass one source (`src_…`, `org/slug`, or `--source`) or use `--org` alone to fetch the whole org; the CLI errors on the conflict. `--org` skips push-only `agent` sources (they have no fetch adapter).
- Remote concurrency defaults to 3, capped at 5. Duplicate source fetches are detected and blocked.
- Smart fetch backoff: sources returning no changes back off exponentially (1h → 48h); error backoff caps at 72h.

### Backfill (full history)

Walk every scrape window of a windowed `scrape` source and upsert the whole history at once — the turnkey replacement for bespoke per-source backfill scripts. Idempotent (dedups by synthesized URL), and **dry-run by default**:

```bash
releases admin source backfill my-source                    # preview: counts + date range, nothing written
releases admin source backfill my-source --no-dry-run        # write (or --commit)
releases admin source backfill my-source --max-windows 100   # walk further back (endpoint clamps 1–200, default 50)
releases admin source backfill my-source --wait              # deep Firecrawl backfill: block until the async workflow finishes
releases admin source backfill my-source --markdown-file page.md --commit
cat page.md | releases admin source backfill my-source --markdown-file - --commit
```

Notes:

- Accepts a slug or `src_…` ID; the CLI resolves to the typed ID before calling (the endpoint rejects bare slugs as ambiguous across orgs).
- `--markdown-file` supplies the full-page markdown for JS-heavy / bot-blocked sources the worker can't fetch itself. Without it the endpoint falls back to Firecrawl (if enabled on the source) then a plain fetch.
- Scrape sources only. Non-scrape sources, an unfetchable body, or a missing `ANTHROPIC_API_KEY`/`FIRECRAWL_API_KEY` come back as a clear error.
- A dry run reports `windows`, `extracted → unique`, and the date range; it warns if it hit the window cap (raise `--max-windows`).
- Deep Firecrawl backfills run as a durable workflow (minutes). Like `admin overview batch`, the CLI **dispatches and returns the workflow instance ID by default** (non-blocking — the agent-friendly default), then either:
  - poll it yourself: `releases admin source backfill-status <instanceId> [--json]` (single-shot; loop on the `--json` `status` field), or
  - pass `--wait` to block and render the report inline.
- Non-Firecrawl / `--markdown-file` sources stay **synchronous** — the report comes back in one call regardless of `--wait`.

### Re-extract (from a stored snapshot)

Re-run extraction over a source's captured raw body in R2 (`released-raw`) — **no live scrape, no Firecrawl credits, deterministic input**. Use it after extraction/parse logic improves to reprocess a source's history. Sibling of `backfill`, **dry-run by default**:

```bash
releases admin source reextract my-source                          # preview from the latest snapshot
releases admin source reextract my-source --commit                 # write (or --no-dry-run)
releases admin source reextract my-source --snapshot-id raw_abc123 --commit   # pin a specific capture
releases admin source reextract my-source --max-windows 100 --json
```

Notes:

- Slug or `src_…` ID, resolved to the typed ID before calling (bare slugs rejected). Scrape sources only.
- Omitting `--snapshot-id` uses the most recent capture; the report's `snapshot` block names which one was used.
- Actionable errors surface as-is: `no_snapshot`/`snapshot_not_found` (404, none stored / wrong id), `snapshot_expired` (410, body past the 90-day R2 lifecycle — re-scrape to capture fresh), missing `RAW_SNAPSHOTS`/`ANTHROPIC_API_KEY` (503).

### Poll (cheap change detection)

```bash
releases admin source poll                  # HEAD-check all feed sources
releases admin source poll next-js          # one source
releases admin source poll --changed        # only show sources flagged with changes
releases admin source poll --json
```

Pure HEAD-based, no AI or parsing. The hosted cron runs this hourly; `--changed` is mostly useful for ad-hoc checks.

### Fetch history

```bash
releases admin source fetch-log                   # across all sources
releases admin source fetch-log next-js           # one source
```

### Health checks

```bash
releases admin source check             # all sources
releases admin source check next-js     # one source
```

## Organizations

```bash
releases admin org create "Vercel" --category developer-tools --tags typescript,edge
releases admin org create "Vercel" --tags typescript,edge --dry-run    # preview, no write
releases admin org list                                   # summary view
releases admin org get vercel                             # full details (accounts, tags, sources, products, aliases)
releases admin org update vercel --category developer-tools
releases admin org link vercel --platform github --handle vercel
releases admin org tag add vercel react serverless
releases admin org alias add anthropic claude.ai claude.com
releases admin source fetch --org vercel                  # fetch all of an org's active sources (skips push-only agent sources)
releases admin org delete vercel                          # reversible tombstone soft-delete
releases admin org delete vercel --hard --yes             # permanent purge + FK cascade
```

There is no `org refresh` command. To refresh an org: fetch its sources with `releases admin source fetch --org <slug>` (see **Fetch** above), then regenerate the overview with the `overview` subcommands — `releases admin overview inputs <slug>` → generate the body → `releases admin overview update <slug>` (or `releases admin overview batch` for a server-side sweep). Overview generation is agent-driven; no single command does both.

### Stub-tier orgs

A stub org carries identity + declared release locations but no sources (buildinternet/releases#1947):

```bash
releases admin org create-stub "Example" --domain example.com --location '{"url":"https://example.com/changelog"}'
releases admin org create-stub "Example" --from-file locations.json      # locations array or full body JSON
releases admin org create-stub-from-domain example.com --dry-run         # from /.well-known/releases.json
releases admin org promote example --dry-run                             # materialize locations → sources, tier → tracked
```

`--location` is repeatable and takes one JSON locator per flag (`url` / `feed` / `github` / `appstore` / `file`, plus optional `title` / `canonical`). `promote` is idempotent — an already-tracked org is a no-op.

`org delete` soft-deletes by default (a reversible tombstone). `--hard` purges the row and cascade-deletes every dependent source, release, fetch-log, changelog file/chunk, summary, media asset, and webhook subscription; it prompts for a slug typeback unless `--yes` is passed (required in non-TTY/scripted contexts). You can pass a slug or an `org_…` ID either way — the CLI resolves to the typed ID the destructive path requires.

## Products

Products group sources under multi-product orgs (e.g. Vercel → Next.js, Turborepo, v0):

```bash
releases admin product create "Next.js" --org vercel --url https://nextjs.org
releases admin product create "Stripe Node" --org stripe --kind sdk
releases admin product list vercel
releases admin product list openai --kind sdk           # filter by taxonomy
releases admin product list                             # every product, all orgs (adds an Org column)
releases admin product list --kind sdk --json           # cross-org kind audit (CLI↔MCP list_catalog parity)
releases admin product update nextjs --description "React framework for production"
releases admin product update stripe-node --kind sdk    # classify
releases admin product update stripe-node --no-kind     # clear
releases admin product tag add nextjs react
releases admin product alias add nextjs nextjs.org
releases admin product delete nextjs          # sources become unlinked, not deleted
releases admin product adopt nextjs --into vercel   # convert an org into a product
```

`--kind` on a product is inherited by its sources (when the source has no kind of its own) on content-oriented surfaces. Use it to classify a whole multi-source product family (e.g. "Stripe's SDKs are all kind=sdk") instead of stamping every source individually.

## Releases

```bash
releases admin release get rel_abc123
releases admin release update rel_abc123 --title "Fixed title" --version "v2.0.1"
releases admin release delete rel_abc123
releases admin release delete rel_a rel_b rel_c              # bulk hard-delete
releases admin release delete --file ids.txt                 # one rel_… per line (- for stdin)
releases admin release suppress rel_abc123 --reason "promotional content"
releases admin release suppress rel_a rel_b --reason "noise"   # bulk suppress
releases admin release suppress --file ids.txt --reason spam
releases admin release unsuppress rel_abc123
releases admin release unsuppress rel_a rel_b                # bulk unsuppress
```

Suppressed releases are hidden from all read paths (search, latest, stats, API) but preserved for audit.

## Policies

Ignored URLs are **org-scoped**; blocked URLs are **global**.

```bash
releases admin policy ignore add https://example.com/blog --org vercel --reason "Not a changelog"
releases admin policy ignore list --org vercel
releases admin policy block add medium.com --domain --reason "Aggregator"
releases admin policy block list
```

## Discovery

AI-powered onboarding for whole companies:

```bash
releases admin discovery onboard "Vercel"
releases admin discovery onboard "Stripe" --domain stripe.com --github-org stripe
releases admin discovery evaluate https://linear.app/changelog --json
releases admin discovery task list                # in-flight discovery sessions
releases admin discovery task cancel <sessionId>
```

## Import

Bulk-import orgs and sources from a JSON manifest:

```bash
releases admin source import manifest.json
releases admin source import manifest.json --dry-run
releases admin source import manifest.json --skip-existing
```

## MCP bridge

Run a local stdio MCP bridge that proxies the hosted tools:

```bash
releases admin mcp serve
```

Useful for clients that only support stdio transport. For native remote MCP support (Claude Code, Codex), connect directly to `https://agents.releases.sh/mcp` instead.

## Recommendations

Review and triage the source URLs that users submit keyless via `releases submit` (and the [web submit form](https://releases.sh/submit)). The submit side needs no key; only the review verbs below do.

```bash
releases admin recommendations list                          # newest first
releases admin recommendations list --status new --type source
releases admin recommendations list --include-archived --cursor <cursor>
releases admin recommendations triage <id> --status closed   # new | triaged | closed
releases admin recommendations archive <id>                  # hide from default list
releases admin recommendations archive <id> --undo           # restore
releases admin recommendations delete <id>                   # permanent — type the id to confirm, or --yes
releases admin recommendations notify-added <id> --org acme [--source changelog]
```

`list` is cursor-paginated (`--limit`, follow `--cursor` from the previous page) and hides archived rows unless `--include-archived` is passed. Prefer `archive` over `delete` for a reversible removal. Recommendation ids are `rec_…`. Mirrors the `releases admin feedback …` triage surface.

`notify-added` is opt-in: it emails the submitter’s contact address that their suggestion is now on the registry, and links the live org (or org/source) page. It does **not** run when you triage, close, or archive. A second call is a no-op (`already_notified`). Skip it when there is no contact email. `--org` is required (`orgSlug` on the wire); `--source` is optional.
