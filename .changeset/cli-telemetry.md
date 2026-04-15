---
"@buildinternet/releases": minor
---

Adds anonymous usage telemetry for the CLI and local MCP stdio server. Each invocation records command name, CLI version, OS/arch, runtime, exit code, and duration against a stable anonymous ID at `~/.releases/telemetry-id` — no arguments, flag values, paths, slugs, or content are ever sent. Events carry a `clientKind` so external usage can be distinguished from internal agents, sandboxes, CI, and MCP stdio traffic, and an optional `sessionId`/`model` for attribution back to managed agent sessions.

Opt out with `releases telemetry disable`, `RELEASED_TELEMETRY_DISABLED=1`, or `DO_NOT_TRACK=1`. A one-time first-run notice prints to stderr on external clients. New `releases telemetry status/enable/disable` commands manage the local state.
