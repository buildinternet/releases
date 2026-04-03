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

## Commands

| Command | Purpose |
|---------|---------|
| `released list --query <company>` | Check what sources exist for a company |
| `released fetch <slug> --max 50` | Pull recent releases from a source |
| `released latest <slug> --json` | Structured release list with dates |
| `released summarize <slug> --window 90` | AI-generated rolling summary |
| `released compare <slugA> <slugB> --days 60` | Head-to-head comparison |

## Workflow

### 1. Define the cohort

Pick 3-6 companies in the same competitive space. Good cohorts share a common buyer or technical layer (e.g., developer databases, frontend frameworks, observability tools).

### 2. Check existing sources

```bash
released list --query <company> --json
```

If a company isn't in the system, onboard it with `released onboard <company>`.

### 3. Fetch recent releases

```bash
released fetch <source-slug> --max 50
```

The CLI skips unchanged feeds automatically. Fetch multiple sources concurrently when possible.

### 4. Summarize each company

```bash
released summarize <source-slug> --window 90
```

Capture the narrative summary for each company. Note dominant themes, release cadence, and version strategy.

### 5. Compare interesting pairs

```bash
released compare <slugA> <slugB> --days 60
```

Pick 2-3 matchups between direct competitors or companies making divergent bets. Look for convergent features, divergent investments, and breaking changes that signal strategic shifts.

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
- Fill data gaps with web fetches. Use `list <slug> --json` to get release URLs, then WebFetch to spot-check pages for missing dates, versions, or feature details.
- Use `latest <slug> --json` for velocity counting — it returns structured data with dates.
- The `--json` flag on `summarize` and `compare` returns structured output for programmatic use.
