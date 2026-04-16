---
title: "Source Management"
adminOnly: true
---

# Source Management

Add, edit, remove, and organize changelog sources. Operator workflows live under `releases admin ...` and require an API key.

## Add sources

```bash
releases admin source add "Next.js" --url https://github.com/vercel/next.js
releases admin source add "Linear" --url https://linear.app/changelog
releases admin source add --name "My Blog" --url https://example.com/changelog
```

By default, `add` runs automated pre-checks to determine the best ingestion method. GitHub URLs use the Releases API directly; other URLs are evaluated for feed discovery, provider detection, and scrape feasibility.

Override detection with `--type github`, `--type scrape`, or `--type feed`. If you know the feed URL, provide it directly:

```bash
releases admin source add "Claude Code" --url https://docs.anthropic.com/en/changelog \
  --feed-url https://docs.anthropic.com/en/changelog/rss.xml
```

## Edit sources

The `edit` command accepts a source ID (`src_...`) or slug. IDs are preferred — slugs can change, IDs are immutable.

```bash
releases admin source edit src_abc123 --name "New Name"    # by ID (preferred)
releases admin source edit next-js --url https://github.com/vercel/next.js/releases
releases admin source edit my-blog --org acme
releases admin source edit my-blog --type feed
releases admin source edit my-blog --primary
releases admin source edit my-blog --slug new-slug --confirm-slug-change  # rename (breaks web links)
```

Slug renames require `--confirm-slug-change` because they break existing web links.

## Remove sources

```bash
releases admin source remove my-blog
```

## Read or refresh a CHANGELOG file

For `github` sources, the root-level `CHANGELOG.md` is tracked alongside tagged releases and surfaced in the web UI as a separate tab.

```bash
# Print the full file to stdout
releases admin source changelog apollo-client

# Slice a character range, snapped to heading boundaries
releases admin source changelog apollo-client --limit 10000
releases admin source changelog apollo-client --offset 10000 --limit 10000

# Slice a token budget (cl100k_base) — ideal for LLM context windows
releases admin source changelog apollo-client --tokens 5000
releases admin source changelog apollo-client --tokens 10000 --json

# JSON output carries totalTokens + sliceTokens alongside offset/nextOffset/totalChars
releases admin source changelog apollo-client --limit 5000 --json

# Manually refresh the cached copy (local mode only — remote mode uses a worker cron on a 24h TTL)
releases admin source refresh-changelog apollo-client
```

Works in both local and remote mode. The slicer snaps boundaries to `##` headings so sections are never cut mid-entry. `--tokens` and `--limit` both operate under the same rules; `--tokens` wins when both are passed. Chain successive calls by feeding `nextOffset` back as `--offset`. Recommended token brackets: 2000 / 5000 / 10000 / 20000.

## Evaluate

Evaluate a URL without adding it as a source:

```bash
releases admin discovery evaluate https://linear.app/changelog
```

## Organizations

Group sources under organizations for aggregate queries:

```bash
releases admin org add "Vercel"
releases admin org link vercel --platform github --handle vercel
releases admin org list
releases admin org show vercel
```

## Products

Group sources under products within an organization:

```bash
releases admin product add "Next.js" --org vercel --url https://nextjs.org
releases admin product list vercel
releases admin product edit nextjs --description "React framework for production"
releases admin product remove nextjs
```

Convert an org that should be a product:

```bash
releases admin product adopt nextjs --into vercel
```

## Domain aliases

Map alternate domains to organizations or products:

```bash
releases admin org alias add anthropic claude.ai claude.com
releases admin product alias add nextjs nextjs.org
```

## Categories & tags

```bash
releases admin org add "Acme" --category cloud --tags typescript,edge
releases admin org tag add acme react serverless
releases admin product tag add acme-cli testing
```

## Import from manifest

Bulk-import organizations and sources from a JSON file:

```bash
releases admin source import manifest.json
releases admin source import manifest.json --dry-run
releases admin source import manifest.json --skip-existing
```

## Onboarding

Use the AI agent to discover, validate, and add sources for a company:

```bash
releases admin discovery onboard "Vercel"
releases admin discovery onboard "Stripe" --domain stripe.com --github-org stripe
```

## Discover

Find changelog pages for a domain:

```bash
releases admin discovery discover vercel.com
releases admin discovery discover vercel.com --verify
releases admin discovery discover vercel.com --add
```

## Ignored & blocked URLs

```bash
releases admin policy ignore add https://example.com/blog --org vercel --reason "Not a changelog"
releases admin policy ignore list --org vercel
releases admin policy block add medium.com --domain --reason "Aggregator"
releases admin policy block list
```

## Release management

```bash
releases admin release show rel_abc123
releases admin release edit rel_abc123 --title "Fixed title"
releases admin release delete rel_abc123
releases admin release suppress rel_abc123 --reason "promotional content"
```

## Persisted summaries

Generate cached AI summaries with configurable windows:

```bash
releases admin content summary generate next-js
releases admin content summary generate next-js --window 30
releases admin content summary generate next-js --monthly
```

## Source health checks

```bash
releases admin source check
releases admin source check next-js
```

## Fetch log

```bash
releases admin source fetch-log
releases admin source fetch-log next-js --limit 50
```

## Task management

Manage remote fetch and discovery sessions:

```bash
releases admin discovery task list
releases admin discovery task cancel <sessionId>
```
