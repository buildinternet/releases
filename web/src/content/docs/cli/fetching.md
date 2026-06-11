---
title: "Fetching Releases"
description: "Pull new releases from configured sources into the index (operator-only)."
adminOnly: true
---

# Fetching Releases

Pull new releases from configured sources into the index. Fetching is an operator workflow, so it lives under `releases admin source ...`. Fetches are dispatched server-side; scrape sources run as managed-agent sessions, while GitHub and feed sources use direct adapters.

## Basic usage

```bash
releases admin source fetch src_abc123        # one source by ID
releases admin source fetch my-source         # one source by slug
releases admin source fetch acme/changelog    # org/slug coordinate
releases admin source fetch --source next-js  # flag form of the same thing
```

A bare `releases admin source fetch` with no identifier or filter is blocked to prevent accidental bulk work — pass a source or one of the filters below.

## Targeted batch modes

Rather than fetching everything, target sources by state. These respect backoff timers and change detection:

```bash
releases admin source fetch --stale 6         # not fetched in 6+ hours
releases admin source fetch --unfetched       # never fetched
releases admin source fetch --changed         # upstream change detected by the hourly poll
releases admin source fetch --retry-errors    # last fetch errored
```

The server caps each fetch at 200 releases per source and detects (and blocks) duplicate fetches of the same source.

### How backoff works

Sources track `consecutiveNoChange` and `consecutiveErrors` counters. These drive exponential backoff:

| Counter               | When it increments             | Backoff schedule           |
| --------------------- | ------------------------------ | -------------------------- |
| `consecutiveNoChange` | A fetch detects no new content | 1h → 2h → 4h → … → 48h max |
| `consecutiveErrors`   | A fetch fails                  | 1h → 2h → 4h → … → 72h max |

The `--stale` flag respects these timers via the `nextFetchAfter` column.

## Fetching a whole org

```bash
releases admin source fetch --org acme
```

Fetches every active source for the organization, skipping push-only `agent` sources (they have no fetch adapter). `--org` can't be combined with a single source identifier — pass one or the other.

## Waiting for completion

The CLI returns as soon as the work is dispatched. `--wait` blocks until the session reaches a terminal state:

```bash
releases admin source fetch my-source --wait      # default timeout (900s)
releases admin source fetch --org acme --wait 60  # wait up to 60 seconds
```

`--wait` exits non-zero on failure: 2 for managed-agent/provider errors, 1 for our-side errors, 130 for cancellation. Pair with `--trace-dir <dir>` to write the terminal session trace to disk (default `~/.releases/work/runs`).

## Dry run

Probe a single source without writing to the database or billing the managed agent:

```bash
releases admin source fetch my-source --dry-run
```

Feed and GitHub sources report the candidate releases parsed. A client-rendered scrape source renders its index page once and reports candidate link counts and sample URLs — no extraction, no managed-agent dispatch.

## Local handoff

`--local` stages a local-ingest handoff instead of dispatching the remote managed agent: it runs the robots.txt/Content-Signal preflight, resolves the source, discovers candidate page URLs, and prints a handoff brief for the calling agent to extract and write itself.

```bash
releases admin source fetch my-source --local
releases admin source fetch my-source --local --force   # override a Content-Signal refusal
```

## AI content fill

When a fetch inserts new releases for a source whose org has auto-generated content enabled, the server follows up with a fill pass that populates missing AI titles and summaries for that source (up to 100 releases per fetch). There is no flag — it's gated by the org-level opt-in.

## Options reference

| Flag                | Description                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `--source <id>`     | Source ID (`src_…`), `org/slug` coordinate, or slug (alternative to the positional arg)                  |
| `--org <org>`       | All active sources for an org (skips push-only `agent` sources; not combinable with a source identifier) |
| `--stale <hours>`   | Only sources older than N hours                                                                          |
| `--unfetched`       | Only never-fetched sources                                                                               |
| `--changed`         | Only sources with detected upstream changes                                                              |
| `--retry-errors`    | Only sources whose last fetch errored                                                                    |
| `--wait [seconds]`  | Block until the dispatched session finishes; non-zero exit on failure                                    |
| `--trace-dir <dir>` | With `--wait`, write the terminal session trace to disk                                                  |
| `--local`           | Stage a local-ingest handoff (no managed agent)                                                          |
| `--force`           | With `--local`, override a Content-Signal refusal                                                        |
| `--dry-run`         | Probe a single source without writing or billing                                                         |
| `--json`            | Machine-readable output                                                                                  |
