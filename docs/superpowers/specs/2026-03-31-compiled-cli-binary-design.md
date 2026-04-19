# Compiled CLI Binary for Sandbox

**Date:** 2026-03-31
**Status:** Approved

## Problem

The sandbox container copies the entire Released source tree, installs Bun, runs `bun install`, and interprets TypeScript at runtime. This is unnecessary — the container just needs to run CLI commands. The full source tree increases image size, build time, and attack surface.

## Solution

Compile the CLI into a self-contained binary using `bun build --compile`. The Dockerfile copies the binary and agent skill files — no Bun install, no `node_modules`, no source tree.

## Build

Two new scripts in `package.json`:

```json
"build": "bun build --compile src/index.ts --outfile dist/released",
"build:linux": "bun build --compile src/index.ts --outfile dist/released --target=bun-linux-x64"
```

- `build` — native binary for current platform (macOS for local use)
- `build:linux` — cross-compiled for the sandbox container (Linux x64)
- Output: `dist/released` (add `dist/` to `.gitignore`)

## Agent CLI Invocation

Replace the source-path construction in `src/agent/released.ts`:

```typescript
// Before
const projectRoot = resolve(import.meta.dir, "../..");
const cliCmd = `bun ${projectRoot}/src/index.ts`;

// After
const cliCmd = "released";
```

The binary is on `$PATH` in the container (`/usr/local/bin/released`).

## Skills Directory

Agent skills (`.md` files) must be on disk for the Agent SDK to discover them.

**Resolution order:**

1. `RELEASED_SKILLS_DIR` env var (if set)
2. `/usr/share/released/skills/` (container convention)
3. `~/.released/skills/` (local fallback)

The agent symlinks from the resolved skills directory into `.claude/skills/` for SDK discovery, replacing the current hardcoded project-root path.

## Dockerfile

```dockerfile
FROM docker.io/cloudflare/sandbox:0.8.0

# Copy the compiled binary
COPY dist/released /usr/local/bin/released

# Copy agent skills to conventional path
COPY src/agent/skills/ /usr/share/released/skills/

# Place skills where Agent SDK discovers them
RUN mkdir -p /app/.claude/skills && cp -r /usr/share/released/skills/* /app/.claude/skills/

# Sandbox SDK command timeout — 5 minutes for agent runs
ENV COMMAND_TIMEOUT_MS=300000

# Default data dir
ENV RELEASED_DATA_DIR=/app/data
RUN mkdir -p /app/data

EXPOSE 8081
```

## Code Changes

| File                           | Change                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                 | Replace `build` script, add `build:linux`                                                                                       |
| `src/agent/released.ts`        | Replace `cliCmd` construction with `"released"`. Replace skills path resolution with conventional-path-with-env-override logic. |
| `workers/discovery/Dockerfile` | Replace with simplified version above                                                                                           |
| `.gitignore`                   | Add `dist/`                                                                                                                     |

## Not Changing

- **Local dev workflow** — `bun src/index.ts` continues to work
- **`src/db/migrate.ts`** — Only runs locally, sandbox uses D1
- **`src/index.ts`** — No changes to CLI entry point
- **`workers/api/`** — Unaffected
- **Agent SDK integration** — Same tools, system prompt, and skills
