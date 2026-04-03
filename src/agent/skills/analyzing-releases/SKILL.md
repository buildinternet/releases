---
name: analyzing-releases
description: How to analyze release trends across multiple companies using the Released CLI — covers cohort selection, fetching changelogs, generating AI summaries and comparisons, and synthesizing competitive intelligence (trends, gaps, forecasts). Use this skill whenever asked to compare companies, analyze a market segment, identify industry trends, produce competitive intelligence, or forecast upcoming releases.
---

# Analyzing Releases

Turn changelog data into competitive intelligence by analyzing release patterns across a cohort of related companies.

The Released CLI has three analysis commands that work together:
- `summarize <slug>` — AI-generated rolling summary of a single source's releases
- `compare <slugA> <slugB>` — head-to-head comparison of two sources
- `latest <slug>` — structured release list with titles, versions, and dates

The workflow below chains these with the ingestion commands (`list`, `fetch`) to produce cross-company trend analysis.

## Step 1: Define the Cohort

Pick 3-6 companies in the same competitive space. Too few and you miss patterns; too many and the analysis gets noisy.

Good cohorts share a common buyer or technical layer:
- Developer databases: Supabase, Neon, PlanetScale, Turso, Prisma
- Frontend frameworks: Next.js, Remix, Nuxt, SvelteKit, Astro
- Observability: Datadog, Sentry, PostHog, Grafana
- Edge/serverless: Cloudflare Workers, Vercel, Fly.io, Railway, Render

## Step 2: Check What's Already in the System

```bash
released list --json    # See all existing sources and orgs
```

Filter by org name to see what sources exist for each company:

```bash
released list --query <company> --json
```

If a company isn't in the system yet, onboard it:

```bash
released onboard <company>
```

Or add manually:

```bash
released org add "<Company Name>" --category <category>
released source add "<Source Name>" --org <slug> --url <changelog-url>
```

## Step 3: Fetch Recent Releases

For each company in the cohort, fetch their primary changelog sources. Use `--max` to cap the number of releases (50 is a good default for analysis).

```bash
released fetch <source-slug> --max 50
```

If sources have already been fetched recently, the CLI will skip unchanged feeds (HEAD pre-check). Use `--force` to re-fetch regardless.

For efficiency, fetch multiple sources in parallel by running commands concurrently or using subagents.

## Step 4: Generate Per-Company Summaries

Use `summarize` with a window that matches your analysis period. The `--window` flag takes days (default 90).

```bash
released summarize <source-slug> --window 90
```

This calls the Anthropic API to produce a narrative summary of the releases in that window. Capture the output for each company in the cohort.

Key things to note from each summary:
- **What themes dominate** — are they shipping AI features, enterprise security, DX improvements?
- **Release velocity** — are they shipping daily or monthly?
- **Version strategy** — major releases, pre-release tracks, LTS branches?

## Step 5: Run Head-to-Head Comparisons

Compare the most interesting pairs. The `compare` command generates an AI comparison of recent releases between two sources.

```bash
released compare <slugA> <slugB> --days 60
```

Focus comparisons on direct competitors or companies making divergent bets. You don't need to compare every pair — pick the 2-3 most informative matchups.

Look for:
- **Convergent features** — things both companies shipped in the same window
- **Divergent bets** — where one is investing and the other isn't
- **Breaking changes** — deprecations or migrations that signal strategic shifts

## Step 6: Synthesize the Analysis

With per-company summaries and head-to-head comparisons in hand, synthesize into a structured analysis covering:

### Release Velocity Table
Tabulate releases per company over the analysis window. Note cadence patterns (daily, weekly, monthly) — velocity alone doesn't indicate quality, but cadence reveals organizational priorities.

### Trends Adopted Across the Board
Identify features or capabilities that multiple companies shipped in the same window. When 3+ companies in a cohort ship the same category of feature, that's a market trend, not a coincidence. Rank by adoption breadth.

### Differentiating Bets
For each company, identify what they're investing in that others aren't. This reveals strategic positioning — the company's theory of what matters next.

### Gaps
For each company, identify what competitors have shipped that they haven't. Gaps are either strategic (deliberate omission) or tactical (they'll get to it). Context from the summaries usually reveals which.

### Forecasts
Based on pre-release tracks, announced deprecations, acquisition activity, and feature trajectory, predict each company's likely next 1-2 releases. Be specific — "they'll probably ship X" is more useful than "they're investing in the AI space."

## Output Format

Ask the user where they'd like the analysis saved, or use your best judgment based on the project's conventions. Include a "Process Notes" section at the bottom documenting which CLI commands were used, so the analysis can be reproduced or updated later.

## Tips

- **Use `latest <slug> --json` for velocity counting** — it returns structured data with dates, making it easy to compute release frequency.
- **The `--json` flag on summarize and compare** returns structured output suitable for programmatic processing.
- **Focus the analysis on what companies shipped, not on data quality.** If a source has noisy data (blog posts mixed in, missing dates, sparse content), work around it silently — filter out irrelevant entries in your reasoning and focus on the actual product changes. Don't include commentary about source quality or data gaps in the final report unless a company had to be substantially excluded from the analysis because of it.
- **Fill gaps with web fetches when possible.** If a source has missing dates, sparse content, or limited entries, use `list <slug> --json` to get URLs for individual releases, then use WebFetch (if available) to spot-check pages for additional context like dates, version numbers, or feature details that didn't make it into the feed.
- **Re-run periodically** — competitive landscapes shift. A monthly re-run of the same cohort produces a useful longitudinal view.
