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

## Key Operations

| Operation | CLI | Typed tool |
|-----------|-----|------------|
| Check existing sources | `releases list --query <company> --json` | `list_sources` with query param |
| Fetch releases | `releases admin source fetch <slug> --max 50` | `fetch_source` with identifier (ID or slug) |
| Get latest releases | `releases latest <slug> --json` | `get_latest_releases` with source/org and limit |
| Search releases | `releases search <query> --json` | `search_releases` with query |
| Summarize | `releases summary <slug> --json` | (not available as typed tool) |
| Compare | `releases compare <slugA> <slugB> --json` | (not available as typed tool) |

## Workflow

### 1. Define the cohort

Pick 3-6 companies in the same competitive space. Good cohorts share a common buyer or technical layer (e.g., developer databases, frontend frameworks, observability tools).

### 2. Check existing sources

Search for each company to see what sources are indexed. If a company isn't in the system, it needs to be onboarded first.

### 3. Fetch recent releases

Fetch each source. The system skips unchanged feeds automatically.

### 4. Get latest releases

Get structured release data with dates for each source. Use a limit (e.g., 50) to cap results. For org-wide views, filter by organization instead of individual source.

### 5. Search and cross-reference

Search across all indexed releases to find specific features, breaking changes, or patterns. `search_releases` is hybrid (lexical + semantic) by default — natural-language queries like "auth refresh tokens" or "cold start improvements" work without exact keyword matches. Pass `mode: "lexical"` if you need strict keyword behavior.

**Result shape:** every hit carries a `kind` discriminator:
- `kind: "release"` — a normal release row, use as-is.
- `kind: "changelog_chunk"` — a passage from a stored CHANGELOG.md file. The hit includes `sourceSlug`, `chunkOffset`, and `chunkLength`. Chain into `get_source_changelog({ slug: sourceSlug, offset: chunkOffset, limit: chunkLength * 3 })` to read the surrounding section before quoting it. Chunk hits often surface older or more granular notes than what's in the indexed release rows, so they're useful for "when did X first ship" questions.

For org/product/source discovery (e.g. "find observability vendors with edge offerings"), use `search_registry` instead of `list_sources --query` — it's vector-backed and matches on description and category, not just slug substring.

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
- Fill data gaps with web fetches. List sources to get release URLs, then WebFetch to spot-check pages for missing dates, versions, or feature details.
- For velocity counting, get the latest releases with dates — CLI: `releases latest <slug> --json`, typed tool: `get_latest_releases`.
- AI-powered summarize and compare are only available via CLI (`releases summary`, `releases compare`). When using typed tools, synthesize manually from raw release data.
