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

This is a **reader** workflow — it uses only the public, unauthenticated tools. There is no AI summarize/compare tool on the hosted MCP and no `summary`/`compare` command in the CLI; you fetch the raw release data and synthesize the analysis yourself.

## Tools for each step

| Operation | CLI (reader) | MCP tool |
|-----------|--------------|----------|
| Find what's indexed for a company | `releases search <company> --json` | `search` (with `type: ["orgs","catalog"]`) |
| List a company's sources | `releases list --query <company> --json` | `list_catalog` (scope with `organization`) |
| Latest releases (source or org) | `releases tail <slug> --json` · `releases tail --org <org> --json` | `get_latest_releases` (`organization` / `product`, `since`/`until`) |
| Keyword/semantic release search | `releases search <query> --json` | `search` with `type: ["releases"]` |
| Read one release in full | `releases get <rel_id> --json` | `get_release` |
| Read a tracked CHANGELOG slice | `releases admin source changelog <slug> --tokens <n>` (key-gated; readers use MCP) | `get_catalog_entry` with `changelog_tokens` / `changelog_offset` (keyless) |

All releases are indexed already — you don't need to (and as a reader can't) trigger fetches. If a company isn't in the registry at all, say so rather than trying to onboard it; onboarding is an operator task.

## Workflow

### 1. Define the cohort

Pick 3-6 companies in the same competitive space. Good cohorts share a common buyer or technical layer (e.g., developer databases, frontend frameworks, observability tools).

### 2. See what's indexed

Resolve each company with `search` (or `releases search`). For discovery-style cohorts ("find observability vendors with edge offerings"), `search` with `type: ["orgs","catalog"]` is vector-backed and matches on description and category — better than a slug-substring `list_catalog --query`. If a company isn't found, note it as a gap rather than fabricating data.

### 3. Pull latest releases with dates

Get structured release data per source or per org. Scope by `organization` for a whole-company view, or by a single source/product for a narrower one. Use a `since` window (e.g. `"6m"`) or a count limit to bound the set. Dates are what you'll count for velocity, so keep them.

### 4. Search and cross-reference

Search across all indexed releases to find a specific feature, breaking change, or pattern. Release search is hybrid (lexical + semantic) by default, so natural-language queries like "auth refresh tokens" or "cold start improvements" work without exact keyword matches. Pass `mode: "lexical"` (CLI `--mode lexical`) when you need strict keyword behavior.

**Result shape:** every hit carries a `kind` discriminator:

- `kind: "release"` — a normal release row; use it directly.
- `kind: "changelog_chunk"` — a passage from a stored CHANGELOG.md file. The hit nests the payload under `chunk`: `chunk.source.slug`, `chunk.file_path`, `chunk.offset`, `chunk.length`. Chain into `get_catalog_entry({ identifier: chunk.source.slug, changelog_path: chunk.file_path, changelog_offset: chunk.offset, changelog_limit: chunk.length * 3 })` to read the surrounding section before quoting it — `changelog_path` is what routes monorepos with multiple CHANGELOG files to the right one. Chunk hits often surface older or more granular notes than what's in the indexed release rows, so they're useful for "when did X first ship" questions.

### 5. Synthesize

Combine the raw data into a structured analysis:

- **Release velocity table** — releases per company over the window, cadence pattern
- **Trends adopted across the board** — features 3+ companies shipped in the same window
- **Differentiating bets** — what each company is investing in that others aren't
- **Gaps** — what competitors shipped that a given company hasn't
- **Forecasts** — predictions grounded in pre-release tracks, deprecations, and trajectory

## Output

Ask the user where to save the analysis, or use your best judgment based on the project's conventions. Include a short "Process Notes" section listing the exact commands/tools used, so the analysis is reproducible.

## Important

- Focus on what companies shipped. If a source has noisy data (blog posts mixed in, missing dates), work around it silently — don't pad the report with source-quality commentary unless a company had to be substantially excluded.
- Fill data gaps with web fetches: list a source to get release URLs, then WebFetch to spot-check pages for a missing date, version, or detail.
- For velocity counting, lean on the dated rows from `get_latest_releases` / `releases tail --json`.
- Comparison and summarization are yours to synthesize from raw release data — there is no built-in tool that does it for you.
