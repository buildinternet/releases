# Discover and Set Up Changelog Sources

Given a company name or domain, find their changelog/release-note sources, add them to Released, and fetch recent entries.

## Arguments

- `$ARGUMENTS` — Company name, domain, or org slug (e.g., "Vercel", "linear.app", "stripe")

## Process

### Step 1: Identify the Domain

If given a company name rather than a domain, determine the primary domain. Check if an org already exists:

```bash
bun src/index.ts org list --json
```

If the org exists and has a domain, use it. Otherwise, infer the domain from the company name.

Some companies use multiple TLDs or redirect between domains (e.g., claude.ai vs claude.com, with support on support.claude.com). If the primary domain is sparse (login page, app, or redirect), check alternate TLDs and the parent company domain too.

### Step 2: Run Automated Discovery

The `discover` command handles sitemap parsing, feed detection, HTML link scanning, and provider identification automatically:

```bash
bun src/index.ts discover <domain> --json
```

If the org has a linked GitHub handle, use `--org` to also scan GitHub repos:

```bash
bun src/index.ts discover --org <slug> --json
```

The CLI already knows about common changelog hosting providers (Mintlify, ReadMe, Intercom, Zendesk, Docusaurus, WordPress, etc.) and uses provider-specific hints to find feed URLs and changelog paths. There is no need to manually probe for provider-specific patterns — the CLI does this.

If results look solid, skip to Step 4. If sparse or empty, proceed to Step 3.

### Step 3: Manual Discovery (When Automated Methods Fall Short)

Automated discovery only scans the domain it's given. If a changelog lives on a different subdomain or an unrelated domain, manual investigation is needed.

#### 3a: Check Subdomains

Many companies host changelogs on subdomains the automated scanner doesn't know about:

- `docs.<domain>`, `support.<domain>`, `help.<domain>`, `developers.<domain>`, `status.<domain>`
- `<product>.docs.<domain>` (multi-product companies)

Use `curl -sI <url>` to check if a URL resolves (200 status, not a redirect to the homepage).

When a promising subdomain is found, run `discover` on it directly:

```bash
bun src/index.ts discover docs.example.com --json
```

This lets the CLI's provider detection and feed discovery work on the subdomain too, rather than manually probing provider-specific paths.

#### 3b: Search the Homepage for Clues

```bash
curl -sL https://<domain> | grep -i -o 'href="[^"]*"' | grep -iE 'changelog|release|whats-new'
```

Check the site footer — changelogs are often linked there but not in the main nav.

#### 3c: Check GitHub

If the company has a GitHub organization:

```bash
curl -sH "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/orgs/<handle>/repos?per_page=10&sort=updated" | \
  jq '.[].full_name'
```

### Step 3.5: Evaluate Source Quality

Before adding any source, check whether it's actively maintained. A stale changelog wastes fetch cycles and pollutes search results.

Spot-check freshness:

```bash
# For web pages — look for recent dates
curl -sL <url> | grep -oE '20[0-9]{2}[-/][0-9]{2}' | sort -r | head -3

# For GitHub repos — check latest release date
curl -sH "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/<owner>/<repo>/releases?per_page=1" | \
  jq '.[0].published_at'
```

**Skip a source if:**
- The most recent entry is over 12 months old
- It's a niche sub-section of a larger docs site with no recent activity (e.g., a conformance or migration changelog that was a one-time effort)
- The page returns 200 but is a stub or placeholder with no real content

**Keep a source if:**
- It has entries from the last 12 months, even if infrequent
- It's the primary changelog for a product, even if the cadence is quarterly

When in doubt, exclude rather than include.

### Step 4: Set Up the Organization (if needed)

```bash
bun src/index.ts org add "<Company Name>" --domain <domain>
```

Link GitHub if applicable:

```bash
bun src/index.ts org link <slug> --platform github --handle <github-handle>
```

### Step 5: Add Sources

If `discover` found good results, add them directly:

```bash
bun src/index.ts discover <domain> --org <slug> --add
```

Or add individually:

```bash
# The CLI auto-detects type (github/feed/scrape) from the URL
bun src/index.ts add "<Source Name>" --url <url> --org <org-slug>

# If a feed URL is known but not auto-discoverable, provide it explicitly
bun src/index.ts add "<Source Name>" --url <changelog-url> \
  --feed-url <feed-url> --org <org-slug>
```

### Step 6: Fetch Recent Releases

```bash
bun src/index.ts fetch --org <org-slug>
```

For multi-page changelogs, enable crawl mode:

```bash
bun src/index.ts fetch <source-slug> --crawl
```

### Step 7: Verify

```bash
bun src/index.ts latest <source-slug> --count 3
```

If no releases were fetched, check:
- Is the URL the changelog index page, not an individual entry?
- Does the source need `--crawl` for multi-page changelogs?
- Would providing an explicit `--feed-url` help?

## Tips

- Prefer **feed** sources over **scrape** — they're faster, free, and more reliable. The CLI probes for feeds automatically, but if you know a feed URL exists, pass `--feed-url` when adding
- Let the CLI handle provider detection — it already knows common patterns for Mintlify, ReadMe, Zendesk, Intercom, and others. Focus manual effort on finding the right subdomain/URL, not on reverse-engineering provider-specific paths
- Quality over quantity — a few active, well-structured changelogs are more valuable than dozens of stale or niche ones
- For companies with multiple products, create separate sources for each product's changelog
- The `--json` flag on any command gives machine-readable output for further processing
