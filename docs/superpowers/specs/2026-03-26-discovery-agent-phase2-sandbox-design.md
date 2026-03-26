# Discovery Agent Phase 2 — Cloudflare Sandbox

Date: 2026-03-26

## Goal

Move the discovery agent from a local CLI command (`released onboard <company>`) to a Cloudflare Sandbox container invocable via HTTP. The agent logic (`src/agent/discovery.ts`) is unchanged — this phase wraps it in a Worker + Durable Object that manages sandbox lifecycle.

## Architecture: Worker + Thin DO (Approach 1.5)

```
Client
  |
  |-- POST /onboard { company, domain?, githubOrg? }
  |     -> Worker -> DiscoverySession DO -> Sandbox container
  |     <- { sessionId, status: "running" }
  |
  +-- GET /onboard/:sessionId/status
        -> Worker -> DO.getStatus() -> sandbox.readFile(progress/state)
        <- { status, progress?, result? }
```

**Why a DO wrapper:** Workers have a 30-second CPU time limit. The agent runs 3-5 minutes. The Sandbox SDK is backed by a Durable Object, but the Worker request handler cannot hold a sandbox execution promise open that long. A thin `DiscoverySession` DO uses `ctx.waitUntil()` to hold the execution reference, keeping the sandbox alive after the Worker returns.

**Why not a full state machine DO:** The sandbox filesystem is the state. The DO only tracks three things: is it running, did it finish, did it error. The DiscoveryState JSON is the real artifact.

## Project Structure

### New: `workers/discovery/`

```
workers/discovery/
  |- wrangler.jsonc
  |- Dockerfile
  |- package.json
  +- src/
      |- index.ts              # Worker -- HTTP router, re-exports DO + Sandbox
      |- discovery-session.ts  # DiscoverySession DO -- sandbox lifecycle
      +- types.ts              # Request/response shapes
```

### New in main project

```
src/agent/run-discovery.ts        # Thin entry point for sandbox execution
src/cli/commands/onboard-apply.ts # `released onboard apply <state-file>`
```

### Unchanged

```
src/agent/discovery.ts            # Agent logic -- no modifications
src/agent/mcp-cloudflare-browser.ts # MCP server -- no modifications
src/cli/commands/onboard.ts       # Local CLI command -- stays as-is
```

## Dockerfile

```dockerfile
FROM docker.io/cloudflare/sandbox:0.7.0

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Copy project and install deps
COPY . /app
WORKDIR /app
RUN bun install --frozen-lockfile

# Default data dir for Released CLI
ENV RELEASED_DATA_DIR=/app/data
RUN mkdir -p /app/data
```

Built at deploy time via `wrangler.jsonc`. Every sandbox starts from this image with Bun + Released pre-installed. No runtime package installation.

## Worker (`workers/discovery/src/index.ts`)

Stateless HTTP router with two routes. Re-exports `Sandbox` (required by SDK) and `DiscoverySession` DO.

- **POST /onboard**: Parse `{ company, domain?, githubOrg? }`, generate sessionId (nanoid), get DiscoverySession DO stub, call `stub.startDiscovery(params)`, return `{ sessionId, status: "running" }`.
- **GET /onboard/:sessionId/status**: Get DO stub, call `stub.getStatus()`, return `{ status, progress?, result? }`.

**DB snapshot sourcing:** For MVP, the POST body includes the DB file as a base64-encoded field (`{ company, domain?, githubOrg?, dbSnapshot: "<base64>" }`). The DB is small (typically under 5MB). For production, the Worker reads from D1/Turso directly.

## Durable Object (`workers/discovery/src/discovery-session.ts`)

Thin wrapper that owns the sandbox and holds the execution promise.

### startDiscovery(params)

1. Get sandbox via `getSandbox(this.env.Sandbox, this.ctx.id.toString())`
2. Write DB snapshot to `/app/data/released.db` (matches `RELEASED_DATA_DIR` env var)
3. Build CLI args from params
4. Set `this.status = 'running'`
5. Fire via `this.ctx.waitUntil(sandbox execution promise)` -- DO stays alive until the agent finishes
6. On resolve: set status to `'complete'`. On reject: set status to `'error'` with message.
7. Return `{ sessionId }` immediately

### getStatus()

- If `'error'`: return error message
- If `'complete'`: read `/tmp/discovery-state.json` from sandbox, return parsed result
- If `'running'`: try reading `/tmp/discovery-progress.json` for incremental progress, return whatever is available

## Entry Point (`src/agent/run-discovery.ts`)

Thin script that parses args and calls `runDiscovery()`. Runs inside the sandbox.

- Parses args: `company [--domain X] [--github-org Y]`
- Calls `runDiscovery()` with an `onProgress` callback that writes `/tmp/discovery-progress.json` (throttled to every 5s)
- `runDiscovery()` writes `/tmp/discovery-state.json` on completion
- On error, writes a partial state file in a catch block (status: `"error"`, whatever sources were found so far) so there is always something to return
- Exits 0 on success, 1 on error

Progress file shape:

```json
{
  "step": "validating",
  "sourcesFound": 4,
  "sourcesValidated": 2,
  "currentAction": "Running dry-run fetch for clerk-changelog..."
}
```

## Apply Command (`src/cli/commands/onboard-apply.ts`)

`released onboard apply <state-file-or-json>`

Reads a DiscoveryState, applies approved sources to the real DB:
- Sources with `approved: true` -> runs add with the source's URL, label, and type
- Sources with `approved: false` -> adds to ignore list with the validation error as reason
- Prints summary of actions taken

Works the same whether called locally by a human or programmatically by the Worker.

## Wrangler Config

```jsonc
{
  "name": "released-discovery",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-26",
  "containers": [{
    "class_name": "Sandbox",
    "image": "./Dockerfile",
    "instance_type": "lite",
    "max_instances": 5
  }],
  "durable_objects": {
    "bindings": [
      { "class_name": "Sandbox", "name": "Sandbox" },
      { "class_name": "DiscoverySession", "name": "DISCOVERY_SESSION" }
    ]
  },
  "migrations": [
    { "new_sqlite_classes": ["Sandbox"], "tag": "v1" },
    { "new_classes": ["DiscoverySession"], "tag": "v2" }
  ]
}
```

## Secrets

Set via `wrangler secret put`, not in config files:

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Agent SDK authentication |
| `CLOUDFLARE_ACCOUNT_ID` | Browser Rendering API |
| `CLOUDFLARE_API_TOKEN` | Browser Rendering API |
| `GITHUB_TOKEN` | GitHub API rate limits (optional) |

**Open verification item:** Do Worker secrets propagate into sandbox containers automatically, or must they be written explicitly (e.g., via writing a .env file into the sandbox)? Test during implementation. If explicit, the DO writes them before running the agent.

## Data Flow

```
                    Sandbox boundary
                    +-----------------------------------+
  DB snapshot ------+-> /app/data/released.db           |
  (advisory,        |                                   |
   read-only        |  Agent runs: discover, add,       |
   context)         |  validate, remove                 |
                    |                                   |
                    |  /tmp/discovery-progress.json ----+---> DO.getStatus() (polling)
                    |  /tmp/discovery-state.json -------+---> DO.getStatus() (final)
                    +-----------------------------------+
                                                             |
                    State file is the only artifact ---------+
                    that crosses the boundary.

  DiscoveryState JSON
       |
       v
  `released onboard apply <state-file>`
       |
       |-- approved sources -> `released add`
       +-- rejected sources -> `released ignore add`
       |
       v
  Real DB updated
```

**The sandbox DB is disposable.** It is a snapshot for advisory context (what is already indexed, what is ignored). The agent mutates it freely. Only the DiscoveryState JSON matters.

## Concurrency

Each onboard run gets: unique sessionId -> unique DO instance -> unique sandbox. Two concurrent runs (Clerk + Datadog) are fully isolated. The "apply" step runs sequentially against the real DB.

## Cost and Performance

| Component | Cost |
|-----------|------|
| Agent (Sonnet + Haiku, ~17 turns) | ~$0.40 |
| Sandbox compute (~5 min) | ~$0.05 |
| CF Browser Rendering | minor |
| **Total per run** | **~$0.50** |

| Phase | Time |
|-------|------|
| Container boot (pre-built image) | ~10-15s |
| Agent run | ~3 min |
| **Total** | **~3.5 min** |

Budget cap: $2.00/run, 30 turns. Safety limits unchanged from Phase 1.

## Not in Scope

- **Agent logic changes** -- `discovery.ts` is unchanged
- **Dynamic Workers** -- Phase 3 (probe_urls fan-out, etc.)
- **User review UI** -- Phase 4 (web UI at releases.sh)
- **DB migration to D1/Turso** -- separate initiative, not a Phase 2 dependency
- **Authentication on the Worker endpoints** -- needed before production, but not for initial deployment. Flag for follow-up.

## Error Recovery

If the sandbox crashes mid-run (OOM, network timeout, budget exceeded):

- The DO sets `status: 'error'` via the catch handler on the execution promise
- The state file may not exist. `getStatus()` already handles this (returns error message)
- `run-discovery.ts` wraps the `runDiscovery()` call in try/catch and writes a partial state file on failure (status: `"error"`, whatever sources were found so far). This ensures there is always an artifact to inspect, even on crash.
- The sandbox DB is disposable — partially-added sources do not affect the real DB

## Verify During Implementation

1. **Secrets propagation:** Do Worker secrets flow into sandbox containers as env vars automatically?
2. **ctx.waitUntil() + sandbox execution:** Confirm the DO stays alive for the full 3-5 minute execution.
3. **Sandbox filesystem from Dockerfile:** Verify `/app` contents from the Dockerfile are present when the sandbox starts.
4. **Dockerfile base image:** Verify `docker.io/cloudflare/sandbox:0.7.0` is the correct image path and version. Check the latest Sandbox SDK docs — the image path or required format may differ.
5. **sleepAfter tuning:** Default is 10 minutes. Set to `"3m"` — enough time for the polling endpoint to read the result after the agent finishes, without keeping the container warm for 6+ unnecessary minutes.
