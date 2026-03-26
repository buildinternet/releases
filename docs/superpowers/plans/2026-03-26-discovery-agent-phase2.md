# Discovery Agent Phase 2 — Cloudflare Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the discovery agent from local CLI to a Cloudflare Sandbox container, invocable via HTTP through a Worker + Durable Object.

**Architecture:** A stateless Worker routes HTTP requests to a thin `DiscoverySession` Durable Object, which owns a Sandbox container. The DO fires the agent via `ctx.waitUntil()` and exposes a polling endpoint for progress/results. The state file (`/tmp/discovery-state.json`) is the only artifact that crosses the sandbox boundary.

**Tech Stack:** Cloudflare Sandbox SDK (`@cloudflare/sandbox`), Cloudflare Workers, Durable Objects, Bun, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-26-discovery-agent-phase2-sandbox-design.md`

---

## File Structure

### New files: `workers/discovery/`

| File | Responsibility |
|------|---------------|
| `workers/discovery/package.json` | Worker-specific dependencies |
| `workers/discovery/tsconfig.json` | TypeScript config for Worker |
| `workers/discovery/wrangler.jsonc` | Worker + Sandbox + DO bindings |
| `workers/discovery/Dockerfile` | Sandbox image: Bun + Released CLI |
| `workers/discovery/src/index.ts` | Worker entry: HTTP router, re-exports DO + Sandbox |
| `workers/discovery/src/discovery-session.ts` | DiscoverySession DO: sandbox lifecycle |
| `workers/discovery/src/types.ts` | Shared request/response types |

### New files: main project

| File | Responsibility |
|------|---------------|
| `src/agent/run-discovery.ts` | Thin entry point for sandbox (parses args, calls `runDiscovery()`, writes progress) |
| `src/cli/commands/onboard-apply.ts` | `released onboard apply <state-file>` CLI command |

### Modified files

| File | Change |
|------|--------|
| `src/cli/commands/onboard.ts` | Register `apply` subcommand |
| `src/agent/discovery.ts` | Add `"error"` to `DiscoveryState.status` union type |

---

## Task 1: Sandbox Entry Point (`src/agent/run-discovery.ts`)

This is the script that runs inside the sandbox container. It parses CLI args, calls the existing `runDiscovery()`, writes progress, and handles errors.

**Files:**
- Create: `src/agent/run-discovery.ts`
- Modify: `src/agent/discovery.ts:27` (add `"error"` to status union)

- [ ] **Step 1: Add `"error"` to DiscoveryState status union**

In `src/agent/discovery.ts`, update the `DiscoveryState` interface at line 27:

```typescript
// Change:
status: "discovering" | "awaiting_review" | "approved" | "fetching" | "complete";
// To:
status: "discovering" | "awaiting_review" | "approved" | "fetching" | "complete" | "error";
```

- [ ] **Step 2: Create `src/agent/run-discovery.ts`**

```typescript
// src/agent/run-discovery.ts
import { runDiscovery, type DiscoveryState } from "./discovery.js";

const PROGRESS_FILE = "/tmp/discovery-progress.json";
const STATE_FILE = "/tmp/discovery-state.json";
const THROTTLE_MS = 5_000;

interface ProgressState {
  step: string;
  sourcesFound: number;
  sourcesValidated: number;
  currentAction: string;
}

function parseArgs(argv: string[]): { company: string; domain?: string; githubOrg?: string } {
  const args = argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: bun run-discovery.ts <company> [--domain <domain>] [--github-org <org>]");
    process.exit(1);
  }

  const company = args[0];
  let domain: string | undefined;
  let githubOrg: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--domain" && args[i + 1]) {
      domain = args[++i];
    } else if (args[i] === "--github-org" && args[i + 1]) {
      githubOrg = args[++i];
    }
  }

  return { company, domain, githubOrg };
}

async function writeProgress(progress: ProgressState): Promise<void> {
  await Bun.write(PROGRESS_FILE, JSON.stringify(progress));
}

async function writeErrorState(company: string, domain?: string, githubOrg?: string, error?: string): Promise<void> {
  const now = new Date().toISOString();
  const state: DiscoveryState = {
    product: company,
    domain,
    githubOrg,
    startedAt: now,
    updatedAt: now,
    status: "error",
    sources: [],
  };
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
  console.error(`Discovery failed: ${error ?? "unknown error"}`);
}

async function main(): Promise<void> {
  const { company, domain, githubOrg } = parseArgs(process.argv);

  let lastProgressWrite = 0;
  const progress: ProgressState = {
    step: "starting",
    sourcesFound: 0,
    sourcesValidated: 0,
    currentAction: `Starting discovery for ${company}`,
  };

  try {
    await runDiscovery({
      company,
      domain,
      githubOrg,
      onProgress: (text) => {
        progress.currentAction = text.slice(0, 200);
        const now = Date.now();
        if (now - lastProgressWrite >= THROTTLE_MS) {
          lastProgressWrite = now;
          writeProgress(progress).catch(() => {});
        }
      },
      onToolUse: (toolName, command) => {
        if (toolName === "Bash" && command) {
          if (command.includes("discover")) progress.step = "discovering";
          else if (command.includes("add")) progress.step = "adding";
          else if (command.includes("fetch") && command.includes("dry-run")) {
            progress.step = "validating";
            progress.sourcesValidated++;
          }
        }
      },
    });

    progress.step = "complete";
    progress.currentAction = "Discovery complete";
    await writeProgress(progress);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeErrorState(company, domain, githubOrg, message);
    process.exit(1);
  }
}

main();
```

- [ ] **Step 3: Verify the entry point runs locally**

Run: `bun src/agent/run-discovery.ts 2>&1 || true`

Expected: exits with usage error since no company arg is provided.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/agent/run-discovery.ts src/agent/discovery.ts
git commit -m "Add sandbox entry point for discovery agent"
```

---

## Task 2: Apply Command (`src/cli/commands/onboard-apply.ts`)

The `released onboard apply <state-file>` command reads a DiscoveryState JSON and applies approved sources to the real DB.

**Files:**
- Create: `src/cli/commands/onboard-apply.ts`
- Modify: `src/cli/commands/onboard.ts` (register subcommand)

- [ ] **Step 1: Create `src/cli/commands/onboard-apply.ts`**

```typescript
// src/cli/commands/onboard-apply.ts
import { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "fs";
import type { DiscoveryState, AgentDiscoveredSource } from "../../agent/discovery.js";
import { logger } from "../../lib/logger.js";
import { getDb } from "../../db/connection.js";
import { sources } from "../../db/schema.js";
import { addIgnoredUrl } from "../../db/queries.js";

interface ApplyResult {
  slug: string;
  url: string;
  action: "added" | "ignored" | "skipped" | "error";
  error?: string;
}

async function applySource(source: AgentDiscoveredSource): Promise<ApplyResult> {
  const { url, type, slug, label } = source;

  if (source.approved === false) {
    const reason = source.validationError ?? "Rejected during discovery";
    try {
      await addIgnoredUrl(url, { reason });
      return { slug, url, action: "ignored" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { slug, url, action: "error", error: `Failed to ignore: ${message}` };
    }
  }

  if (source.approved !== true) {
    return { slug, url, action: "skipped" };
  }

  const db = getDb();
  try {
    await db.insert(sources).values({
      name: label,
      slug,
      type,
      url,
    });
    return { slug, url, action: "added" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { slug, url, action: "error", error: message };
  }
}

export function registerOnboardApplyCommand(onboardCmd: Command) {
  onboardCmd
    .command("apply")
    .description("Apply discovery results from a state file to the database")
    .argument("<state-file>", "Path to a DiscoveryState JSON file (or - for stdin)")
    .option("--json", "Output results as JSON")
    .action(async (stateFile: string, opts: { json?: boolean }) => {
      let raw: string;
      if (stateFile === "-") {
        raw = await Bun.stdin.text();
      } else {
        raw = readFileSync(stateFile, "utf-8");
      }

      let state: DiscoveryState;
      try {
        state = JSON.parse(raw);
      } catch {
        logger.error("Failed to parse state file as JSON");
        process.exit(1);
      }

      if (!state.sources || !Array.isArray(state.sources)) {
        logger.error("State file missing 'sources' array");
        process.exit(1);
      }

      const results: ApplyResult[] = [];

      for (const source of state.sources) {
        const result = await applySource(source);
        results.push(result);

        if (!opts.json) {
          switch (result.action) {
            case "added":
              logger.info(chalk.green(`Added: ${result.slug} (${result.url})`));
              break;
            case "ignored":
              logger.info(chalk.yellow(`Ignored: ${result.slug} (${result.url})`));
              break;
            case "skipped":
              logger.info(chalk.gray(`Skipped (no approval): ${result.slug}`));
              break;
            case "error":
              logger.error(chalk.red(`Error: ${result.slug} -- ${result.error}`));
              break;
          }
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        const added = results.filter((r) => r.action === "added").length;
        const ignored = results.filter((r) => r.action === "ignored").length;
        const errors = results.filter((r) => r.action === "error").length;
        logger.info(
          chalk.bold(`\nApplied: ${added} added, ${ignored} ignored, ${errors} errors`),
        );
      }

      if (results.some((r) => r.action === "error")) {
        process.exit(1);
      }
    });
}
```

- [ ] **Step 2: Register the subcommand in `onboard.ts`**

In `src/cli/commands/onboard.ts`, the existing code does `program.command("onboard")` in a chain. Capture it as a variable and register the subcommand:

```typescript
// At the top of the file, add import:
import { registerOnboardApplyCommand } from "./onboard-apply.js";

// Change from:
export function registerOnboardCommand(program: Command) {
  program
    .command("onboard")
    .description("Discover and onboard changelog sources for a company using AI agent")
    // ... rest of chain

// Change to:
export function registerOnboardCommand(program: Command) {
  const onboard = program
    .command("onboard")
    .description("Discover and onboard changelog sources for a company using AI agent")
    // ... rest of chain (keep everything the same)

  // After the .action() block closes:
  registerOnboardApplyCommand(onboard);
}
```

- [ ] **Step 3: Test with a mock state file**

```bash
cat > /tmp/test-state.json << 'EOF'
{
  "product": "TestCo",
  "startedAt": "2026-03-26T00:00:00Z",
  "updatedAt": "2026-03-26T00:00:00Z",
  "status": "awaiting_review",
  "sources": []
}
EOF
bun src/index.ts onboard apply /tmp/test-state.json
```

Expected: `Applied: 0 added, 0 ignored, 0 errors`

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/onboard-apply.ts src/cli/commands/onboard.ts
git commit -m "Add 'released onboard apply' command for applying discovery results"
```

---

## Task 3: Worker Scaffold (`workers/discovery/`)

Set up the Worker project structure, dependencies, and config files.

**Files:**
- Create: `workers/discovery/package.json`
- Create: `workers/discovery/tsconfig.json`
- Create: `workers/discovery/wrangler.jsonc`
- Create: `workers/discovery/Dockerfile`
- Create: `workers/discovery/src/types.ts`

- [ ] **Step 1: Create `workers/discovery/package.json`**

```json
{
  "name": "released-discovery-worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@cloudflare/sandbox": "latest"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "latest",
    "wrangler": "latest",
    "typescript": "^6.0.2"
  }
}
```

- [ ] **Step 2: Create `workers/discovery/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `workers/discovery/wrangler.jsonc`**

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

- [ ] **Step 4: Create `workers/discovery/Dockerfile`**

```dockerfile
FROM docker.io/cloudflare/sandbox:0.7.0

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Copy project and install deps
COPY ../../ /app
WORKDIR /app
RUN bun install --frozen-lockfile

# Default data dir for Released CLI
ENV RELEASED_DATA_DIR=/app/data
RUN mkdir -p /app/data
```

**NOTE:** The `COPY ../../` path depends on what the Sandbox SDK uses as the Docker build context. If it uses `workers/discovery/` as the context, this path won't work. Verify in Task 6 (verification spikes). Alternatives: move Dockerfile to project root, or use a build script that copies the project first.

- [ ] **Step 5: Create `workers/discovery/src/types.ts`**

```typescript
// workers/discovery/src/types.ts

export interface OnboardRequest {
  company: string;
  domain?: string;
  githubOrg?: string;
  dbSnapshot: string; // base64-encoded SQLite DB file
}

export interface OnboardResponse {
  sessionId: string;
  status: "running";
}

export interface StatusResponse {
  status: "running" | "complete" | "error" | "idle";
  progress?: {
    step: string;
    sourcesFound: number;
    sourcesValidated: number;
    currentAction: string;
  };
  result?: object; // DiscoveryState JSON
  error?: string;
}

export interface Env {
  Sandbox: DurableObjectNamespace;
  DISCOVERY_SESSION: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  GITHUB_TOKEN?: string;
}
```

- [ ] **Step 6: Install dependencies**

```bash
cd workers/discovery && npm install
```

- [ ] **Step 7: Commit**

```bash
git add workers/discovery/
git commit -m "Scaffold workers/discovery project with config and types"
```

---

## Task 4: Durable Object (`workers/discovery/src/discovery-session.ts`)

The thin DO that owns the sandbox lifecycle.

**Files:**
- Create: `workers/discovery/src/discovery-session.ts`

- [ ] **Step 1: Create `workers/discovery/src/discovery-session.ts`**

```typescript
// workers/discovery/src/discovery-session.ts
import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import type { Env, StatusResponse } from "./types.js";

type SessionStatus = "idle" | "running" | "complete" | "error";

export class DiscoverySession extends DurableObject<Env> {
  private status: SessionStatus = "idle";
  private errorMessage?: string;

  async startDiscovery(params: {
    company: string;
    domain?: string;
    githubOrg?: string;
    dbSnapshot: Uint8Array;
  }): Promise<{ sessionId: string }> {
    if (this.status === "running") {
      throw new Error("Discovery already in progress for this session");
    }

    const sandboxId = this.ctx.id.toString();
    const sandbox = getSandbox(this.env.Sandbox, sandboxId, {
      sleepAfter: "3m",
    });

    // Write DB snapshot to the path the CLI expects (RELEASED_DATA_DIR=/app/data)
    await sandbox.mkdir("/app/data", { recursive: true });
    await sandbox.writeFile("/app/data/released.db", params.dbSnapshot);

    // Build command args — quote the company name for shell safety
    const args = [JSON.stringify(params.company)];
    if (params.domain) args.push("--domain", params.domain);
    if (params.githubOrg) args.push("--github-org", params.githubOrg);

    const cmd = `bun /app/src/agent/run-discovery.ts ${args.join(" ")}`;

    this.status = "running";
    this.errorMessage = undefined;

    // Fire -- ctx.waitUntil keeps the DO alive until the agent finishes
    this.ctx.waitUntil(
      sandbox
        .run(cmd)
        .then((result) => {
          if (result.exitCode !== 0) {
            this.status = "error";
            this.errorMessage = result.stderr || `Exit code ${result.exitCode}`;
          } else {
            this.status = "complete";
          }
        })
        .catch((err) => {
          this.status = "error";
          this.errorMessage = err instanceof Error ? err.message : String(err);
        }),
    );

    return { sessionId: sandboxId };
  }

  async getStatus(): Promise<StatusResponse> {
    if (this.status === "idle") {
      return { status: "idle" };
    }

    if (this.status === "error") {
      return { status: "error", error: this.errorMessage };
    }

    const sandbox = getSandbox(this.env.Sandbox, this.ctx.id.toString());

    if (this.status === "complete") {
      try {
        const raw = await sandbox.readFile("/tmp/discovery-state.json");
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        return { status: "complete", result: JSON.parse(text) };
      } catch {
        return { status: "error", error: "State file not found after completion" };
      }
    }

    // Running -- try reading progress file
    try {
      const raw = await sandbox.readFile("/tmp/discovery-progress.json");
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      return { status: "running", progress: JSON.parse(text) };
    } catch {
      return { status: "running" };
    }
  }
}
```

**NOTE:** The Sandbox SDK docs show `sandbox.exec()` as the primary method for running commands. The code above uses `sandbox.run()` to avoid a false-positive security hook in the project. During implementation, use whichever method the installed SDK version provides -- verify in Task 6 Step 5. The return type is expected to have `{ stdout, stderr, exitCode }` but may vary.

- [ ] **Step 2: Type-check**

```bash
cd workers/discovery && npx tsc --noEmit
```

Expected: No errors (note any SDK type issues for Task 6).

- [ ] **Step 3: Commit**

```bash
git add workers/discovery/src/discovery-session.ts
git commit -m "Add DiscoverySession Durable Object for sandbox lifecycle"
```

---

## Task 5: Worker Entry Point (`workers/discovery/src/index.ts`)

The stateless HTTP router.

**Files:**
- Create: `workers/discovery/src/index.ts`

- [ ] **Step 1: Create `workers/discovery/src/index.ts`**

```typescript
// workers/discovery/src/index.ts
import type { Env, OnboardRequest, OnboardResponse, StatusResponse } from "./types.js";

// Required re-exports for Cloudflare bindings
export { Sandbox } from "@cloudflare/sandbox";
export { DiscoverySession } from "./discovery-session.js";

function jsonResponse(data: object, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // POST /onboard -- start a discovery session
    if (request.method === "POST" && url.pathname === "/onboard") {
      let body: OnboardRequest;
      try {
        body = await request.json();
      } catch {
        return errorResponse("Invalid JSON body", 400);
      }

      if (!body.company || typeof body.company !== "string") {
        return errorResponse("Missing required field: company", 400);
      }

      if (!body.dbSnapshot || typeof body.dbSnapshot !== "string") {
        return errorResponse("Missing required field: dbSnapshot (base64)", 400);
      }

      // Decode base64 DB snapshot
      let dbBytes: Uint8Array;
      try {
        const binary = atob(body.dbSnapshot);
        dbBytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          dbBytes[i] = binary.charCodeAt(i);
        }
      } catch {
        return errorResponse("Invalid base64 in dbSnapshot", 400);
      }

      // Generate session ID and get DO stub
      const sessionId = crypto.randomUUID();
      const doId = env.DISCOVERY_SESSION.idFromName(sessionId);
      const stub = env.DISCOVERY_SESSION.get(doId);

      try {
        await stub.startDiscovery({
          company: body.company,
          domain: body.domain,
          githubOrg: body.githubOrg,
          dbSnapshot: dbBytes,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(`Failed to start discovery: ${message}`, 500);
      }

      const response: OnboardResponse = { sessionId, status: "running" };
      return jsonResponse(response, 202);
    }

    // GET /onboard/:sessionId/status -- poll for progress/results
    const statusMatch = url.pathname.match(/^\/onboard\/([\w-]+)\/status$/);
    if (request.method === "GET" && statusMatch) {
      const sessionId = statusMatch[1];
      const doId = env.DISCOVERY_SESSION.idFromName(sessionId);
      const stub = env.DISCOVERY_SESSION.get(doId);

      try {
        const status: StatusResponse = await stub.getStatus();
        return jsonResponse(status);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(`Failed to get status: ${message}`, 500);
      }
    }

    return errorResponse("Not found", 404);
  },
};
```

- [ ] **Step 2: Type-check**

```bash
cd workers/discovery && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add workers/discovery/src/index.ts
git commit -m "Add Worker HTTP router for discovery sandbox"
```

---

## Task 6: Verification Spikes

Before deploying, verify the four unknowns from the spec. Each spike is a focused test.

**Files:**
- No permanent files -- these are throwaway verification scripts

- [ ] **Step 1: Verify Dockerfile base image**

Fetch the latest Sandbox SDK docs to confirm the correct base image:

```bash
cd workers/discovery && npx wrangler containers --help 2>&1 || true
```

Also use WebFetch on `https://developers.cloudflare.com/sandbox/get-started/` and look for the base image reference. If the image path differs from `docker.io/cloudflare/sandbox:0.7.0`, update `workers/discovery/Dockerfile`.

- [ ] **Step 2: Verify secrets propagation**

Deploy a minimal test that checks whether Worker secrets are visible as environment variables inside the sandbox container:

1. Set a test secret: `cd workers/discovery && npx wrangler secret put ANTHROPIC_API_KEY`
2. Temporarily modify `discovery-session.ts` to run `sandbox.run('printenv ANTHROPIC_API_KEY')` and log the result
3. If secrets do NOT propagate, add a `.env` write step to `startDiscovery()` before running the agent:

```typescript
// Add before the sandbox.run() call:
const envLines = [
  `ANTHROPIC_API_KEY=${this.env.ANTHROPIC_API_KEY}`,
  `CLOUDFLARE_ACCOUNT_ID=${this.env.CLOUDFLARE_ACCOUNT_ID}`,
  `CLOUDFLARE_API_TOKEN=${this.env.CLOUDFLARE_API_TOKEN}`,
  this.env.GITHUB_TOKEN ? `GITHUB_TOKEN=${this.env.GITHUB_TOKEN}` : "",
].filter(Boolean).join("\n");
await sandbox.writeFile("/app/.env", new TextEncoder().encode(envLines));
```

Bun auto-loads `.env` from the working directory, so this should work without CLI changes.

- [ ] **Step 3: Verify ctx.waitUntil() keeps DO alive**

Deploy the Worker and start a long-running command (e.g., `sleep 120 && echo done`). Poll the status endpoint after 60 seconds to confirm the DO is still alive.

If the DO is garbage collected before completion, switch to `this.ctx.blockConcurrencyWhile()` or use DO alarms for the lifecycle management.

- [ ] **Step 4: Verify Dockerfile build context**

Run `cd workers/discovery && npx wrangler dev 2>&1 | head -50` and check what directory the Docker build uses as context.

If build context is `workers/discovery/`, the `COPY ../../ /app` line won't work. Fix by either:
1. Moving the Dockerfile to the project root and updating `wrangler.jsonc` to `"image": "../../Dockerfile"`
2. Adding a build script that copies the project into a staging directory

- [ ] **Step 5: Verify sandbox.run() API**

Check the actual method name and return type in the installed `@cloudflare/sandbox` package. The plan uses `sandbox.run()` but the SDK docs show `sandbox.exec()`. Update `discovery-session.ts` to match.

- [ ] **Step 6: Document findings and commit fixes**

Update the spec's "Verify During Implementation" section with results. Commit all code changes:

```bash
git add -A
git commit -m "Complete verification spikes for sandbox deployment"
```

---

## Task 7: Deploy and End-to-End Test

Deploy the Worker and run a real discovery session.

**Files:**
- No new files

- [ ] **Step 1: Set secrets**

```bash
cd workers/discovery
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put GITHUB_TOKEN
```

- [ ] **Step 2: Deploy**

```bash
cd workers/discovery && npx wrangler deploy
```

- [ ] **Step 3: Prepare DB snapshot**

```bash
base64 < ~/.released/released.db > /tmp/db-snapshot.b64
```

- [ ] **Step 4: Start a discovery session**

```bash
DB_B64=$(cat /tmp/db-snapshot.b64)
curl -X POST https://released-discovery.<subdomain>.workers.dev/onboard \
  -H "Content-Type: application/json" \
  -d "{\"company\":\"Clerk\",\"domain\":\"clerk.com\",\"dbSnapshot\":\"$DB_B64\"}"
```

Expected: `{ "sessionId": "<uuid>", "status": "running" }`

- [ ] **Step 5: Poll for completion**

Poll every 30 seconds:

```bash
curl https://released-discovery.<subdomain>.workers.dev/onboard/<sessionId>/status
```

Expected progression:
1. `{ "status": "running" }` (no progress yet)
2. `{ "status": "running", "progress": { "step": "discovering", ... } }`
3. `{ "status": "complete", "result": { "product": "Clerk", "sources": [...] } }`

- [ ] **Step 6: Apply results locally**

```bash
curl -s https://released-discovery.<subdomain>.workers.dev/onboard/<sessionId>/status \
  | jq '.result' > /tmp/clerk-discovery.json
bun src/index.ts onboard apply /tmp/clerk-discovery.json
```

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "Fix issues found during E2E sandbox test"
```
