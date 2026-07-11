---
title: "Privacy & Telemetry"
description: "What the CLI and local MCP server collect, how to inspect it, and how to opt out."
adminOnly: false
---

# Privacy & Telemetry

Releases collects anonymous usage data from the CLI and the local MCP stdio server so we can understand which commands and tools are actually used. This page documents exactly what is collected, how to see it, and how to turn it off.

For the full privacy policy covering the web app, API request logs, third-party processors, and data retention, see [/privacy](/privacy).

## What is collected

Every CLI command and every local MCP tool call records a single event with:

- **Command or tool name** — e.g. `search`, `list`, or `tool get_latest_releases`
- **CLI version** — e.g. `0.10.0`
- **Device info** — operating system, architecture, and how the CLI is running (e.g. `darwin arm64`, compiled binary or Bun)
- **Outcome** — exit code and duration in milliseconds
- **Anonymous ID** — a random UUID generated on first run and stored at `~/.releases/telemetry-id`
- **Timestamp** — when the event occurred

## What is never collected

- Command arguments or flag values
- File paths, source slugs, org or product names, release IDs
- Search queries, prompt text, or any other content you type
- Usernames, email addresses, hostnames, IP addresses (beyond what any HTTP request exposes to the receiving server)
- The contents of any release, changelog, or summary

## Anonymous ID

The first time the CLI runs, a random UUID is written to `~/.releases/telemetry-id` with `0600` permissions. This ID is not tied to a user, account, or machine identifier. It's a random value that lets us count unique clients across events. Deleting the file on your end resets your identity.

## First-run notice

On first run, the CLI prints a one-time notice to `stderr` summarizing what is collected and how to opt out. The notice is suppressed on subsequent runs, on CI, and on clients that identify as internal.

## Opting out

You can disable telemetry at any time. Any of the following will silence it:

```bash
releases telemetry disable              # persistent opt-out (stored locally)
RELEASES_TELEMETRY_DISABLED=1 releases … # per-invocation opt-out
DO_NOT_TRACK=1 releases …                # also respected
```

To see the current state, the anonymous ID, and the endpoint events would post to:

```bash
releases telemetry status
```

To re-enable:

```bash
releases telemetry enable
```

## How events are sent

Events are sent best-effort to `POST /v1/telemetry` on the public API with a 1.5-second timeout. If the request fails, times out, or the machine is offline, the event is silently dropped. Telemetry never blocks a command and never surfaces errors.

## Retention

Telemetry events are retained for 90 days and then deleted.

## Questions

For questions about telemetry or anything else data-related, email [privacy@releases.sh](mailto:privacy@releases.sh). For takedown requests, email [abuse@releases.sh](mailto:abuse@releases.sh). For security reports, email [security@releases.sh](mailto:security@releases.sh). The full privacy policy lives at [/privacy](/privacy).
