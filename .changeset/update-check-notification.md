---
"@buildinternet/releases": minor
---

feat: show update notification when CLI is outdated, indicate dev mode

- After each command, checks npm for a newer version (cached 24h) and prints a dim one-liner to stderr with the right upgrade command (npm or brew, auto-detected)
- Skipped for --version, --help, and telemetry commands; never blocks or throws
- Running from source (bun src/index.ts) shows version as "x.y.z-dev" and skips the check entirely
