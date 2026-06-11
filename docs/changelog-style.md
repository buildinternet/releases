# Changelog style guide

How the daily self-changelog (`CHANGELOG.md`, published to the `releases-sh` org) is curated. The
draft agent reads this file before drafting; humans use it when editing a draft PR.

## Audience

Developers and AI agents who **use** releases.sh — via the `releases` CLI, the web frontend
(releases.sh), the public REST API, the remote MCP server, search, and source/org onboarding. A
change is changelog-worthy if a user of those surfaces would notice or benefit.

## Include

New CLI commands/flags, new MCP tools, web UI features/pages, public API endpoints, search
capabilities, new source-type/adapter support (what kinds of changelogs can be ingested),
org/product features, notable user-felt bug fixes, and UX/perf improvements users notice.

## Exclude (never make a bullet for these)

Internal refactors, test changes, CI/build/tooling, dependency bumps, schema migrations (unless they
directly enable a user feature — then describe the feature, not the migration), logging, code
cleanup, non-user-facing docs, and anything unreleased / flag-gated that wasn't actually shipped.

## Conventional-commit prior

`feat` and `fix` PRs are candidates; `chore` / `test` / `refactor` / `docs` / `perf` are dropped by
default. The PR title + body + diff inform the final call — inspect the diff when a PR's user impact
is unclear.

## Format

- One `## <Month D, YYYY>` heading per active day (no leading zero on the day), newest at the top.
- Under it, `**Added**` / `**Changed**` / `**Fixed**` bold sections in that order; omit any empty
  section.
- Dash bullets, "Thing — what it does for you" phrasing.
- Distill aggressively: a 70-commit day might yield 3–7 bullets. Merge related PRs into one bullet.
- A quiet or all-internal day produces no section at all.

## Guardrails

No PR numbers, no commit hashes, no internal file/function names, no conventional-commit prefixes,
no competitor-named bug call-outs, and never mention features that weren't actually shipped.

## Reference

The existing top sections of `CHANGELOG.md` are the canonical examples of voice and density.
