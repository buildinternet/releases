# Discover and Set Up Changelog Sources

Given a company name or domain, find their changelog/release-note sources, add them to Releases, and fetch recent entries. This is the manual, Claude-driven onboarding flow — it uses the `releases` CLI against the production API and does not dispatch to managed agents. (If you want managed-agent onboarding, use `releases admin discovery onboard <company>` directly.)

## Arguments

- `$ARGUMENTS` — Company name, domain, or org slug (e.g., "Vercel", "linear.app", "stripe")

## Prerequisites

- `releases` CLI installed and authenticated with an admin API key (`releases whoami` to verify).
- Invoke the `releases:finding-changelogs` skill before evaluating URLs — it's the source of truth for priority order (well-known files > link relations > feeds > GitHub > raw markdown > scraping) and content-verification red flags.
- Invoke `releases:managing-sources` before writing — it documents the tool reference table, naming conventions, and the validation workflow.

## Process

### Step 1: Identify the Domain

If given a company name rather than a domain, determine the primary domain. Check if an org already exists:

```bash
releases admin org list --json | jq '.items[] | select(.name | test("<query>"; "i"))'
```

If the org exists and has a domain, use it. Otherwise, infer the domain from the company name.

Some companies use multiple TLDs or redirect between domains (e.g., claude.ai vs claude.com, with support on support.claude.com). If the primary domain is sparse (login page, app, or redirect), check alternate TLDs and the parent company domain too.

### Step 2: Manual Discovery

With local-only discovery retired, Claude does the discovery work directly — following the priority order in `releases:finding-changelogs`. Work through these tiers until you have candidate URLs:

1. **Well-known files** — `curl -sI https://<domain>/.well-known/changelog.json`, then `releases.json`, `changelog.txt`, `/AGENTS.md`, `/changelog.md`, `/releases.md` (and uppercase variants).
2. **Link relations on the homepage** — fetch the homepage and grep for `rel="alternate"` feeds or `rel="changelog"` link tags.
3. **Footer and nav scan** — `curl -sL https://<domain> | grep -i -oE 'href="[^"]*(changelog|release|whats-new|updates)[^"]*"'`. Footers often link changelogs that aren't in the main nav.
4. **Subdomains** — `docs.<domain>`, `support.<domain>`, `help.<domain>`, `developers.<domain>`, `status.<domain>`, `<product>.docs.<domain>`. `curl -sI` to check each resolves (200, not a redirect to the homepage).
5. **Provider-specific hints** — if the page is hosted on a known changelog provider (Mintlify, ReadMe, Intercom, Zendesk, Docusaurus, WordPress, Ghost), the `finding-changelogs` skill lists their feed-URL conventions.
6. **GitHub** — if the company has a GitHub handle, check repos for active tagged releases:
   ```bash
   curl -sH "Authorization: Bearer $GITHUB_TOKEN" \
     "https://api.github.com/orgs/<handle>/repos?per_page=10&sort=updated" | \
     jq '.[].full_name'
   ```

### Step 3: Evaluate Source Quality

For each candidate URL, run the AI-backed evaluator to get the recommended ingestion method (feed / github / markdown / scrape / crawl), feed URL, provider detection, and confidence:

```bash
releases admin discovery evaluate <url> --json
```

This is often enough on its own to pick the right source type — skip manual feed sniffing when the evaluator returns a high-confidence feed URL.

Then spot-check freshness:

```bash
# Web pages — look for recent dates
curl -sL <url> | grep -oE '20[0-9]{2}[-/][0-9]{2}' | sort -r | head -3

# GitHub repos — check latest release date
curl -sH "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/<owner>/<repo>/releases?per_page=1" | \
  jq '.[0].published_at'
```

Skip sources that are stale (no entries in the last 12 months), stub pages, or niche sub-sections with no real activity. Quality over quantity — a few active changelogs beat dozens of dead ones. When in doubt, exclude.

See the "Content Verification" section of `releases:finding-changelogs` for red flags that a feed is actually a blog or marketing RSS, not a changelog.

### Step 4: Set Up the Organization (if needed)

```bash
releases admin org add "<Company Name>" --domain <domain> --description "<one sentence>"
```

The description grounds AI summaries and feeds the registry vector index — write a real sentence, not a tagline.

Link GitHub if applicable:

```bash
releases admin org link <slug> --platform github --handle <github-handle>
```

### Step 5: Add Sources

The CLI auto-detects type (`github` / `scrape` / `feed` / `agent`) from the URL. If you have a known feed URL that isn't auto-discoverable, pass it explicitly.

```bash
releases admin source add "<Source Name>" --url <url> --org <org-slug>

# With explicit feed URL:
releases admin source add "<Source Name>" --url <changelog-url> \
  --feed-url <feed-url> --org <org-slug>
```

**Naming:** don't prefix the org name — see the naming rules in `releases:managing-sources` (GitHub repos → bare repo name; scrape/feed → strip the org prefix unless it's part of the canonical product name).

Mark the main company-wide changelog as primary:

```bash
releases admin source edit <slug> --primary
```

Batch adds accept a JSON manifest:

```bash
releases admin source add --batch sources.json
```

### Step 6: Fetch Recent Releases

```bash
# Preview first
releases admin source fetch <slug> --dry-run

# Real fetch
releases admin source fetch <slug>

# All active sources for an org
releases admin source fetch --org <org-slug>
```

### Step 7: Verify

```bash
releases tail <source-slug> --count 3
releases admin source fetch-log <slug> --json    # check for errors
```

If no releases were fetched:

- Is the URL the changelog index, not an individual entry?
- Does the source need `--feed-url` (some feeds aren't auto-discoverable)?
- Does the scrape adapter need `--render` (JS-rendered content)?

### Step 8: Write the Playbook (scrape/agent sources)

For orgs with `scrape` or `agent` sources, write verified agent notes once you have real fetch data:

```bash
releases admin playbook <slug> --notes-file - <<'EOF'
### Fetch instructions
...

### Traps
**<label>**: ...

### Coverage
...
EOF
```

The full structure and "verified vs compilation" distinction is in the Playbooks section of `releases:managing-sources`. Skip this step for feed-only or GitHub-only orgs.

### Step 9: Regenerate the Overview

Once releases are in, kick the overview so the org has an AI-generated summary:

```bash
releases admin org refresh <slug> --skip-overview   # if you already fetched
# …or do fetch + overview in one shot:
releases admin org refresh <slug>
```

## Tips

- Prefer **feed** sources over **scrape** — faster, free, more reliable. The CLI probes for feeds automatically; pass `--feed-url` if you know one that isn't auto-discoverable.
- Let the `finding-changelogs` skill handle provider patterns — don't reverse-engineer Mintlify/ReadMe paths by hand.
- For multi-product orgs, create separate sources per product. Use `releases admin product add` when a product deserves its own grouping layer.
- `--json` on any admin read command gives machine-readable output for piping into `jq` or batch scripts.
- For bulk onboarding across many companies, use `releases admin discovery onboard` (managed agents) instead of this manual flow — it parallelizes over remote workers.
