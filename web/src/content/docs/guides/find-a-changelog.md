---
title: "How to Find Any Product's Changelog"
description: "A practical method for locating a product's changelog or release notes — common URL patterns, feed discovery, GitHub, provider fingerprints — plus the shortcut: an index that has already done it."
adminOnly: false
---

# How to find any product's changelog

Changelogs have no standard home. Teams publish in GitHub releases, `CHANGELOG.md` files, marketing blogs, documentation sites, in-app "what's new" panels, and vendor newsletters — and the interesting entries rarely live where you'd guess. This guide gives you a repeatable method for finding the best source for any product, whether you're a person hunting for release notes or an agent that needs structured data.

The short version: guess the obvious URLs first, then look for a feed, then check GitHub, and only scrape a rendered page as a last resort. Or skip the hunt — [Releases](/) has already run this method across hundreds of products, and you can [query the result](#the-shortcut-query-an-index-that-already-did-this) for free.

## The method, in priority order

Work down this list and stop at the first hit. Each step trades a little more effort for a little less structure.

### 1. Try the obvious URLs

Most products that publish a changelog put it at a guessable address. Try these against the product's domain, in roughly descending order of popularity:

- **Paths:** `/changelog`, `/updates`, `/releases`, `/release-notes`, `/whats-new`, `/news` — and the same paths under a docs site (`/docs/changelog`, `/docs/release-notes`).
- **Subdomains:** `changelog.{domain}` and `updates.{domain}`.
- **Root files**, for developer-oriented projects: `/changelog.md` or `/changelog.txt` on the domain.

A site search (`site:example.com changelog OR "release notes" OR "what's new"`) catches the stragglers — products that bury updates under a blog tag or a help-center section. If the product is multi-product (one company, several tools), expect per-product changelogs: check the product's own docs site, not just the company domain.

### 2. Look for an RSS or Atom feed

A feed is the best source you'll commonly find: structured entries, stable dates, no parsing of rendered HTML. Two ways to find one:

- **Feed autodiscovery.** View the changelog page's HTML source and look for `<link rel="alternate" type="application/atom+xml">` (or `rss+xml`) in the `<head>`.
- **Well-known paths.** Try the common ones against the changelog URL and the site root: `/feed`, `/feed.xml`, `/rss.xml`, `/atom.xml`, `/changelog.rss`, `/changelog/rss.xml`, `/rss/`.

The changelog platform often gives the path away. Sites hosted on Mintlify serve `/rss.xml`; ReadMe and Fern serve `/changelog.rss`; Docusaurus blogs serve `/blog/rss.xml`; Ghost serves `/rss/`; WordPress serves `/feed/`. If you can identify the platform (page footer, HTTP headers, HTML patterns), try its known path first.

**Verify the feed is actually the changelog.** This is the step most people skip, and it's where feed discovery goes wrong. Sample a few entries and check that they describe product changes. Red flags:

- Entry URLs point at `/blog/` rather than `/changelog/` or `/releases/`
- Titles read like articles ("Choosing a logging library: the definitive guide")
- No version numbers or feature/fix language anywhere
- The feed is site-wide (`/feed.xml` at the root) rather than scoped to the changelog section

A site-wide blog feed that happens to include release posts will bury them in marketing. Keep looking for a section-scoped feed before settling for it.

### 3. Check GitHub

For developer tools, GitHub often holds the richest history — sometimes richer than the official page:

- **Tagged releases**: `github.com/{owner}/{repo}/releases`, available as structured data from the [Releases API](https://docs.github.com/en/rest/releases/releases) and as a built-in Atom feed at `github.com/{owner}/{repo}/releases.atom`.
- **The `CHANGELOG.md` file** at the repo root (also `CHANGES.md`, `HISTORY.md`, `RELEASES.md`, or `NEWS.md`). Many projects write entries here that never become tagged releases, so check it even when tagged releases exist.

The catch: GitHub only covers what ships through the repo. Launch announcements, pricing changes, and hosted-product updates usually appear on the company's site and never get a tag. For a full picture of a commercial product, you typically need both the GitHub source and the website changelog.

### 4. Last resort: the rendered page

If there's no declaration, no feed, and no repo, you're left with the changelog page itself. Before committing to scraping, look for an escape hatch in the page source: a `.md` view of the page, a feed URL buried in JavaScript, or a link to the underlying markdown on GitHub. Docs platforms frequently expose one of these even when nothing is advertised.

If nothing structured exists, the page must be scraped and diffed on a schedule — fragile, and hostile to automate from scratch. Watch out for two traps: client-rendered pages that return an empty app shell to plain HTTP requests, and bot-protection challenges that block automated fetching entirely. This is precisely the case where an existing index earns its keep.

### Worth one extra request: machine-readable declarations

A small but growing number of products declare their changelog location explicitly: a [`/.well-known/releases.json`](/docs/listing) or `/.well-known/changelog.json` manifest on the domain, or a `<link rel="changelog">` tag in the homepage's `<head>`. Adoption is still low, so don't lead with this — but the check costs one request, and when it hits it's the publisher stating intent, not a heuristic. If you're automating discovery, run it alongside step 1. (If you own a product, [declaring one](/docs/listing) makes every tool in this guide work on the first try.)

## The shortcut: query an index that already did this

Releases runs this method — declarations, feed discovery, provider detection, GitHub, and monitored scraping for the holdouts — across hundreds of developer tools and services, then normalizes everything into one registry: org, product, title, date, summary, categories. Most reads are public, with no account or API key.

**On the web:** [search](/search) for the product, or browse the [catalog](/catalog). Every org page collects all of its sources — the GitHub releases and the marketing changelog side by side.

**From a domain:** if all you have is `vercel.com`, resolve it directly:

```bash
curl "https://api.releases.sh/v1/lookups/by-domain?domain=vercel.com"
```

**From the command line:**

```bash
npm install -g @buildinternet/releases   # or: brew install buildinternet/tap/releases

releases search "tailwind"        # find the org and its sources
releases tail tailwindcss         # latest releases from one source
releases tail --org vercel        # latest across an org
```

**For agents:** add the hosted MCP server and "where is X's changelog, and what changed?" becomes one tool call:

```bash
claude mcp add --transport http releases https://mcp.releases.sh/mcp
```

Or install the [agent skills](/docs/skills) so Claude Code, Codex, Cursor, and OpenCode reach for the CLI on their own: `npx skills add buildinternet/releases-cli`.

**As a feed:** every org, source, and collection page serves Atom — append `.atom` to its URL. See [Turn any changelog into an RSS feed](/docs/guides/changelog-rss-feed).

If a product isn't indexed yet, [submit it](/submit) — or, if it's yours, [get listed](/docs/listing).

## FAQ

### Is there a standard format for changelogs?

For the file itself, [Keep a Changelog](https://keepachangelog.com) is the closest thing to a convention, and only for projects that maintain a `CHANGELOG.md`. For _discovery_ — telling machines where your changelog lives — emerging pieces like [`/.well-known/releases.json`](/docs/listing) and `<link rel="changelog">` exist (see above), but adoption is thin. In practice the de facto standard is the guessable URL: `/changelog` or `/updates` on the product's domain.

### What's the difference between a changelog and release notes?

In practice, nothing reliable. "Changelog" leans toward exhaustive, versioned lists; "release notes" leans toward curated highlights per release. Companies use the terms interchangeably, and the same product may have both. When hunting, search for both terms, plus "what's new" and "product updates".

### How do AI agents check changelogs?

Three common patterns: fetch and parse a feed or `CHANGELOG.md` directly (works per-product, breaks on scrape-only sites), call GitHub's Releases API (works for repos only), or query an aggregator over MCP or REST so one integration covers every product. The MCP route is the cheapest in tokens: the index has already extracted titles, dates, and summaries, so the agent doesn't burn context parsing HTML.

### Why doesn't every product have a feed?

Many changelog platforms (Notion, GitBook, Intercom, and most custom-built pages) simply don't emit one. The publisher would have to add it deliberately, and most never do — which is why a method that ends in "someone monitors the rendered page for you" is unavoidable for full coverage.

### The changelog page exists but is always behind the product's actual releases. Now what?

Common with marketing-managed changelogs. Add the product's GitHub repo (step 3) as a second source — tags land at ship time even when the page lags. This is exactly why Releases tracks multiple sources per org.
