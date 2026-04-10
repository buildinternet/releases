---
name: analyzing-releases
description: >
  Analyze release trends across multiple companies to produce competitive
  intelligence. Use when asked to compare companies, analyze a market segment,
  identify industry trends, forecast upcoming releases, or answer questions
  like "what is X shipping lately" or "how does X compare to Y." Also triggers
  on requests for competitive landscape analysis, feature gap analysis, or
  release velocity comparisons.
---

# Analyzing Releases

Turn changelog data into competitive intelligence by analyzing release patterns across a cohort of related companies.

## Tools

| Tool | Purpose |
|------|---------|
| `list_sources` with query param | Check what sources exist for a company |
| `fetch_source` with slug | Pull recent releases from a source |
| `get_latest_releases` with source/org and limit | Structured release list with dates |
| `search_releases` with query | Find releases across all sources |

## Workflow

### 1. Define the cohort

Pick 3-6 companies in the same competitive space. Good cohorts share a common buyer or technical layer (e.g., developer databases, frontend frameworks, observability tools).

### 2. Check existing sources

Use `list_sources` with a query to check what sources exist for each company. If a company isn't in the system, it needs to be onboarded first.

### 3. Fetch recent releases

Use `fetch_source` for each source slug. The system skips unchanged feeds automatically.

### 4. Get latest releases

Use `get_latest_releases` with the source slug and a limit (e.g., 50) to get structured release data with dates. For org-wide views, pass the organization parameter instead.

### 5. Search and cross-reference

Use `search_releases` to find specific features, breaking changes, or patterns across all indexed releases.

### 6. Synthesize

Combine summaries and comparisons into a structured analysis:

- **Release velocity table** — releases per company, cadence pattern
- **Trends adopted across the board** — features 3+ companies shipped in the same window
- **Differentiating bets** — what each company is investing in that others aren't
- **Gaps** — what competitors shipped that a company hasn't
- **Forecasts** — specific predictions based on pre-release tracks, deprecations, and trajectory

## Output

Ask the user where to save the analysis, or use your best judgment based on the project's conventions. Include a "Process Notes" section documenting which CLI commands were used so the analysis is reproducible.

## Important

- Focus on what companies shipped. If a source has noisy data (blog posts mixed in, missing dates), work around it silently. Don't include source quality commentary in the report unless a company had to be substantially excluded.
- Fill data gaps with web fetches. Use `list_sources` to get source details and release URLs, then WebFetch to spot-check pages for missing dates, versions, or feature details.
- Use `get_latest_releases` with a source slug for velocity counting — it returns structured data with dates.
