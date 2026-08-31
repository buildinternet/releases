---
title: "Turn Any Changelog Into an RSS Feed"
description: "Get an Atom feed for any product's changelog — even ones that don't publish a feed. Append .atom to any Releases org, source, or collection page. Free, no account."
adminOnly: false
---

# Turn any changelog into an RSS feed

Plenty of changelogs ship without a feed: the page updates, but there's nothing for a feed reader, a Slack integration, or a script to subscribe to. This guide gets you a working Atom feed for any product's changelog in two steps — check whether a real feed already exists, and if not, subscribe through an index that monitors the page for you.

(Atom and RSS are sibling formats; every feed reader speaks both. The feeds below are Atom.)

## Step 1: check for a native feed

If the publisher already emits a feed, use it — it's first-party and updates the moment they publish. Two quick checks:

- View the changelog page's HTML source and look for `<link rel="alternate" type="application/atom+xml">` (or `rss+xml`) in the `<head>`.
- Try the common paths against the changelog URL: `/feed`, `/feed.xml`, `/rss.xml`, `/atom.xml`, `/changelog.rss`, `/rss/`.

For GitHub projects there's always one: `github.com/{owner}/{repo}/releases.atom` covers tagged releases, no API key needed.

If a feed turns up, spot-check that its entries are actually release content and not the company's whole blog — a site-wide `/feed.xml` full of marketing posts isn't a changelog feed. The [finding-a-changelog guide](/docs/guides/find-a-changelog) covers feed discovery and verification in more depth.

## Step 2: no feed? Append `.atom` to a Releases page

Releases monitors changelogs across hundreds of developer tools and services — including scrape-only pages with no feed of their own — and serves every org, source, and collection as an Atom feed. Find the product on [releases.sh](/) and append `.atom` to the page URL. No account, no API key.

**An organization** — everything a company ships, across all of its changelogs, GitHub repos, and blogs:

```
https://releases.sh/anthropic.atom
```

**A single source** — one specific changelog, when the whole org is too noisy:

```
https://releases.sh/anthropic/claude-code.atom
```

**A collection** — a curated group of related products in one feed, such as every major application platform:

```
https://releases.sh/collections/application-platforms.atom
```

Browse [collections](/collections) for the full list, or use [search](/search) to find the org or source page you want. The same suffix trick works for other formats: `.json` for structured data and `.md` for an LLM-friendly view.

Entries carry the release title, publish date, and a summary, normalized to the same shape regardless of where the release was published — a GitHub tag, an RSS item, or a scraped page look identical to your reader.

### How fresh is it?

Feeds reflect the index. Sources are polled on a rolling schedule (a few hours for active sources), so entries appear shortly after the publisher posts them rather than at the same instant. For most "tell me when X ships" uses that's indistinguishable from native; if you need push-latency delivery, use a webhook instead (below).

## If the product isn't indexed yet

Two paths:

- **Anyone** can [submit a product](/submit) to be tracked.
- **Product owners** can [get listed](/docs/listing) directly — publishing a small `releases.json` manifest on your domain declares where your changelog lives, and doubles as a native discovery signal for any tool, not just this one.

## Beyond feeds

A feed is the lowest-friction subscription, but not the only one — [How to get notified when products ship updates](/docs/guides/release-notifications) covers the push channels in depth:

- **Webhooks** — sign in, follow the orgs you care about, and get a `release.created` POST to your endpoint in real time. See the [webhooks docs](/docs/api/webhooks).
- **REST API** — poll `https://api.releases.sh/v1/releases/latest` with filters for org, source, or date. See the [REST API docs](/docs/api/rest).
- **MCP for agents** — `claude mcp add --transport http releases https://mcp.releases.sh/mcp` gives an agent tools to check what changed on demand, no subscription at all.

## FAQ

### Is this free?

Yes. Feeds, like all public reads on Releases, need no account or API key.

### RSS or Atom — does it matter?

No. Atom is the slightly stricter, younger sibling of RSS, and every feed reader, automation platform, and RSS library handles it. If a tool asks for an "RSS URL", paste the `.atom` URL.

### Can I get one feed for several products?

Yes, two ways: an org feed already merges every source under that company, and [collections](/collections) merge related products across companies into one feed. For an arbitrary custom set, add each source's `.atom` URL to your reader separately — folders in the reader do the merging.

### Why not just scrape the page myself on a cron?

You can, but budget for the failure modes: client-rendered pages that return an empty shell to plain HTTP requests, bot-protection challenges, layout changes that silently break your parser, and diffing logic to avoid re-alerting on old entries. That's the machinery an index maintains so you don't have to.

### The feed exists but my reader shows old entries at the top

Readers sort by the entry's publish date. When an index first ingests a source it may backfill history, and some publishers post entries with earlier dates. Both settle out after the first fetch; sort by date in your reader if it doesn't.
