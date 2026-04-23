---
title: "Summaries & Comparisons"
description: "AI-powered analysis of release activity across sources and orgs (operator-only)."
adminOnly: true
---

# Summaries & Comparisons

AI-powered analysis of release activity across sources and organizations.

## Summary

Generate a natural-language summary of recent releases for a source or across an entire organization.

```bash
releases summary my-source
releases summary --org vercel --days 7
releases summary my-source --instructions "focus on breaking changes"
releases summary --json
```

### Options

| Flag                    | Description                            |
| ----------------------- | -------------------------------------- |
| `--days <n>`            | Look-back window in days (default 30)  |
| `--org <slug>`          | Summarize across all sources in an org |
| `--instructions <text>` | Additional guidance for the summarizer |
| `--json`                | Structured output                      |

## Compare

Generate a head-to-head comparison of recent releases between two sources. Useful for competitive analysis or tracking convergence between related tools.

```bash
releases compare nextjs remix --days 30
releases compare neon-changelog planetscale-changelog --days 60
releases compare --json
```

### What the comparison covers

- **Convergent features** — capabilities both products shipped in the same window
- **Divergent bets** — areas where one is investing and the other isn't
- **Breaking changes** — deprecations or migrations that signal strategic shifts

## Example: competitive intelligence

Compare recent activity across competing products:

```bash
# Summarize each company's recent releases
releases summary --org neon --days 60
releases summary --org supabase --days 60

# Run head-to-head comparisons
releases compare neon-changelog planetscale-changelog --days 60
releases compare neon-changelog supabase --days 60
```
