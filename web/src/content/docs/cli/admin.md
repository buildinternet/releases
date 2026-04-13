---
title: "Source Management"
adminOnly: true
---

# Source Management

Add, edit, remove, and organize changelog sources. Requires an API key.

## Add sources

```bash
released add "Next.js" --url https://github.com/vercel/next.js
released add "Linear" --url https://linear.app/changelog
released add --name "My Blog" --url https://example.com/changelog
```

By default, `add` runs automated pre-checks to determine the best ingestion method. GitHub URLs use the Releases API directly; other URLs are evaluated for feed discovery, provider detection, and scrape feasibility.

Override detection with `--type github`, `--type scrape`, or `--type feed`. If you know the feed URL, provide it directly:

```bash
released add "Claude Code" --url https://docs.anthropic.com/en/changelog \
  --feed-url https://docs.anthropic.com/en/changelog/rss.xml
```

## Edit sources

```bash
released edit next-js --url https://github.com/vercel/next.js/releases
released edit my-blog --org acme
released edit my-blog --type feed
released edit my-blog --primary
```

## Remove sources

```bash
released remove my-blog
```

## Evaluate

Evaluate a URL without adding it as a source:

```bash
released evaluate https://linear.app/changelog
```

## Organizations

Group sources under organizations for aggregate queries:

```bash
released org add "Vercel"
released org link vercel --platform github --handle vercel
released org list
released org show vercel
```

## Products

Group sources under products within an organization:

```bash
released product add "Next.js" --org vercel --url https://nextjs.org
released product list vercel
released product edit nextjs --description "React framework for production"
released product remove nextjs
```

Convert an org that should be a product:

```bash
released product adopt nextjs --into vercel
```

## Domain aliases

Map alternate domains to organizations or products:

```bash
released org alias add anthropic claude.ai claude.com
released product alias add nextjs nextjs.org
```

## Categories & tags

```bash
released org add "Acme" --category cloud --tags typescript,edge
released org tag add acme react serverless
released product tag add acme-cli testing
```

## Import from manifest

Bulk-import organizations and sources from a JSON file:

```bash
released import manifest.json
released import manifest.json --dry-run
released import manifest.json --skip-existing
```

## Onboarding

Use the AI agent to discover, validate, and add sources for a company:

```bash
released onboard "Vercel"
released onboard "Stripe" --domain stripe.com --github-org stripe
```

## Discover

Find changelog pages for a domain:

```bash
released discover vercel.com
released discover vercel.com --verify
released discover vercel.com --add
```

## Ignored & blocked URLs

```bash
released ignore add https://example.com/blog --org vercel --reason "Not a changelog"
released ignore list --org vercel
released block add medium.com --domain --reason "Aggregator"
released block list
```

## Release management

```bash
released release show rel_abc123
released release edit rel_abc123 --title "Fixed title"
released release delete rel_abc123
released release suppress rel_abc123 --reason "promotional content"
```

## Summarize (rolling)

Generate cached AI summaries with configurable windows:

```bash
released summarize next-js
released summarize next-js --window 30
released summarize next-js --monthly
```

## Source health checks

```bash
released check
released check next-js
```

## Fetch log

```bash
released fetch-log
released fetch-log next-js --limit 50
```

## Task management

Manage remote fetch and discovery sessions:

```bash
released task list
released task cancel <sessionId>
```
