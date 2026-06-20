---
title: "Source Management"
description: "Create, update, and organize changelog sources (operator-only)."
adminOnly: true
---

# Source Management

Create, update, delete, and organize changelog sources. Operator workflows live under `releases admin ...` and require an API key.

## Create sources

```bash
releases admin source create "Next.js" --url https://github.com/vercel/next.js
releases admin source create "Linear" --url https://linear.app/changelog
releases admin source create --name "My Blog" --url https://example.com/changelog
```

By default, `create` runs automated pre-checks to determine the best ingestion method. GitHub URLs use the Releases API directly; other URLs are evaluated for feed discovery, provider detection, and scrape feasibility.

Override detection with `--type github`, `--type scrape`, or `--type feed`. If you know the feed URL, provide it directly:

```bash
releases admin source create "Claude Code" --url https://docs.anthropic.com/en/changelog \
  --feed-url https://docs.anthropic.com/en/changelog/rss.xml
```

## Update sources

The `update` command accepts a source ID (`src_...`) or slug. IDs are preferred — slugs can change, IDs are immutable.

```bash
releases admin source update src_abc123 --name "New Name"    # by ID (preferred)
releases admin source update next-js --url https://github.com/vercel/next.js/releases
releases admin source update my-blog --org acme
releases admin source update my-blog --type feed
releases admin source update my-blog --primary
releases admin source update my-blog --slug new-slug --confirm-slug-change  # rename (breaks web links)
```

Slug renames require `--confirm-slug-change` because they break existing web links.

## Delete sources

```bash
releases admin source delete my-blog
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
```

The cached CHANGELOG copy refreshes automatically on a 24-hour cycle; no manual refresh command is needed.

The slicer snaps boundaries to `##` headings so sections are never cut mid-entry. `--tokens` and `--limit` both operate under the same rules; `--tokens` wins when both are passed. Chain successive calls by feeding `nextOffset` back as `--offset`. Recommended token brackets: 2000 / 5000 / 10000 / 20000.

## Evaluate

Evaluate a URL without adding it as a source:

```bash
releases admin discovery evaluate https://linear.app/changelog
```

## Organizations

Group sources under organizations for aggregate queries:

```bash
releases admin org create "Vercel"
releases admin org link vercel --platform github --handle vercel
releases admin org list
releases admin org get vercel
```

## Products

Group sources under products within an organization:

```bash
releases admin product create "Next.js" --org vercel --url https://nextjs.org
releases admin product list vercel
releases admin product update nextjs --description "React framework for production"
releases admin product delete nextjs
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
releases admin org create "Acme" --category cloud --tags typescript,edge
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

Use the AI agent to discover, validate, and create sources for a company:

```bash
releases admin discovery onboard "Vercel"
releases admin discovery onboard "Stripe" --domain stripe.com --github-org stripe
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
releases admin release get rel_abc123
releases admin release update rel_abc123 --title "Fixed title"
releases admin release delete rel_abc123
releases admin release suppress rel_abc123 --reason "promotional content"
```

## Playbook

Read or update an organization's playbook — the agent-facing reference for how each source works.

```bash
# Read the assembled playbook (header + agent notes)
releases admin playbook vercel
releases admin playbook vercel --json

# Replace agent notes — seeds a fresh header on first write
releases admin playbook vercel --notes-file playbook-notes.md
# Or pipe from stdin: cat playbook-notes.md | releases admin playbook vercel --notes-file -
```

The playbook header (source list, products) regenerates automatically after any source create/update/delete.

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

## User feedback

Review feedback submitted through `releases feedback`. Newest first; read-only.

```bash
releases admin feedback list                       # Most recent submissions
releases admin feedback list --type bug            # Filter by type: bug | idea | other | general
releases admin feedback list --status new          # Filter by status: new | triaged | closed
releases admin feedback list --limit 100           # Rows per page (default 50, max 200)
releases admin feedback list --cursor <cursor>     # Next page (from a previous --json `nextCursor`)
releases admin feedback list --json                # Raw envelope: { items, nextCursor }
```

Each entry carries the message, optional contact, type, status, and submission time. Pagination is cursor-based — pass the `nextCursor` from a `--json` response back as `--cursor` to walk older pages.
