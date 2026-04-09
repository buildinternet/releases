# Managed Agents Integration

> **Status: Complete (Phases 1-3).** Phase 4 (full migration) deferred until production validation.

**Goal:** Add Managed Agents as an alternative discovery execution path alongside the existing Cloudflare Sandbox approach, selectable via a `--managed-agents` CLI flag.

**Architecture:** A new `src/agent/managed-discovery.ts` module wraps the Anthropic Managed Agents API. It exposes a single `releases_cli` custom tool that executes CLI commands host-side (secrets never enter the container). The module returns the same `DiscoveryState` interface as the existing `runDiscovery()`, making it a drop-in alternative. Agent and environment IDs are created on first use and cached to `~/.releases/managed-agents.json`.

**Tech Stack:** `@anthropic-ai/sdk` (upgraded to ^0.86.1), Anthropic Managed Agents beta API (`managed-agents-2026-04-01`)

## What shipped

- `src/agent/managed-discovery.ts` — Managed Agents client with custom tool dispatch, state capture, StatusHub event forwarding, 15-min timeout guard
- `src/cli/commands/onboard.ts` — `--managed-agents` flag, shared UI helper
- `src/agent/released.ts` — `DiscoveryStatusEvent` type, `buildDiscoveryPrompt()` shared helper, `onStatusEvent` callback
- `src/lib/config.ts` — `resolveCLICmd()` shared CLI command resolution
- `tests/unit/managed-discovery.test.ts` — 29 unit tests
- SDK upgraded to ^0.86.1

## What's deferred (Phase 4)

- Remote mode support (discovery worker calling Anthropic API directly)
- Remove Cloudflare Sandbox path (blocked on production validation)

---

## Original Phase 2 Plan (reference)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Modify | Upgrade `@anthropic-ai/sdk` to `^0.86.1` |
| `src/agent/managed-discovery.ts` | Create | Managed Agents client — agent/env setup, session lifecycle, custom tool handler, event streaming |
| `src/cli/commands/onboard.ts` | Modify | Add `--managed-agents` flag, wire to new module |

---

### Task 1: Upgrade Anthropic SDK

**Files:**
- Modify: `package.json` (the `@anthropic-ai/sdk` version)

- [ ] **Step 1: Update the SDK version**

In `package.json`, change:
```json
"@anthropic-ai/sdk": "^0.80.0"
```
to:
```json
"@anthropic-ai/sdk": "^0.86.1"
```

- [ ] **Step 2: Install**

Run: `bun install`
Expected: Resolves and installs `@anthropic-ai/sdk@0.86.1` (or newer patch). No peer dependency conflicts.

- [ ] **Step 3: Type-check the existing codebase**

Run: `npx tsc --noEmit`
Expected: No new errors. The SDK upgrade should be backward-compatible. If there are new errors, they'll be in files that import from `@anthropic-ai/sdk` — fix any breaking type changes before proceeding.

- [ ] **Step 4: Smoke-test existing functionality**

Run: `bun src/index.ts list --json | head -5`
Expected: Outputs JSON array of sources. Confirms the CLI still works after the SDK bump.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: upgrade @anthropic-ai/sdk to ^0.86.1 for managed agents support"
```

---

### Task 2: Create managed-discovery module

**Files:**
- Create: `src/agent/managed-discovery.ts`

This is the core module. It mirrors the interface of `runDiscovery()` from `src/agent/released.ts` but uses Anthropic Managed Agents instead of the Claude Agent SDK.

- [ ] **Step 1: Create the module with agent/environment setup**

Create `src/agent/managed-discovery.ts`:

```typescript
/**
 * Discovery via Anthropic Managed Agents.
 *
 * Alternative to the Claude Agent SDK path in released.ts.
 * CLI operations execute host-side via custom tools — secrets never enter
 * the Managed Agent container.
 */

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { $ } from "bun";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { CATEGORIES } from "../lib/categories.js";
import type { DiscoveryState, DiscoveryOptions } from "./released.js";

// ── Cached IDs ────────────────────────────────────────────────────

interface ManagedAgentConfig {
  agentId: string;
  agentVersion: number;
  environmentId: string;
  updatedAt: string;
}

const CONFIG_PATH = resolve(homedir(), ".releases/managed-agents.json");

function loadCachedConfig(): ManagedAgentConfig | null {
  try {
    const raw = require("fs").readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as ManagedAgentConfig;
  } catch {
    return null;
  }
}

function saveCachedConfig(cfg: ManagedAgentConfig): void {
  const dir = resolve(homedir(), ".releases");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  require("fs").writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ── System prompt ─────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You manage changelog sources for Released. You find, evaluate, add, fetch, and validate changelog sources using the releases_cli tool.

## CLI Commands Reference

Call the releases_cli tool with the command string (without the "releases" prefix):

- list [slug] [--json] [--org <org>] [--has-feed] [--enrichable] [--product <p>] [--category <c>] [--query <text>]
- evaluate <url> [--json]: Evaluate a URL for the best ingestion method
- discover <domain> [--json]: Probe a domain for changelog URLs, feeds, and GitHub repos
- add <name> --url <url> [--type <type>] [--org <org>] [--feed-url <url>] [--skip-eval]
- fetch <slug> [--dry-run] [--max <n>] [--full] [--crawl] [--no-crawl]: Fetch releases
- fetch-log <slug>: Show recent fetch history
- remove <slug> [--ignore --reason <reason>]: Remove a source
- enrich <slug> [--dry-run] [--limit <n>] [--force]: Enrich sparse releases
- org add <name> [--domain <d>] [--description <t>] [--category <c>] [--tags <t1,t2>]
- org edit <slug> [--category <c>]
- org show <slug>: Full org details with accounts, tags, sources, products
- org tag add <slug> <tag1> [tag2...]
- product add <name> --org <org> [--category <c>] [--tags <t1,t2>] [--url <u>] [--description <t>]
- product edit <slug> [--category <c>]
- product tag add <slug> <tag1> [tag2...]
- ignore list --org <org> --json / ignore add --org <org> <url>
- block list --json / block add <url>
- categories [--json]: List valid categories
- edit <slug> [--primary] [--no-primary] [--priority <p>] [--metadata <json>]

## Available Categories

Valid categories: ${CATEGORIES.join(", ")}

When creating an organization, always include a --description with a brief one-sentence product description.

## Multi-Product Organizations

Some organizations ship multiple distinct products. When you discover sources that clearly belong to different products:
- High confidence (separate repos, separate domains): Create products using product add
- Medium confidence: Note suggested groupings but don't auto-create
- Low confidence: Leave sources at the org level

## Onboarding Workflow

1. **Discover** — find changelog URLs, feeds, and GitHub repos
2. **Add** — add sources with appropriate types
3. **Validate** — dry-run fetch each source to check quality
4. **Assess content depth** — for feed sources, check if pages have richer content than feeds
5. **Report** — summarize what was found

Do NOT actually fetch (without --dry-run) unless explicitly told to.

## Source Selection

Prefer 3-5 high-signal sources per org over exhaustive coverage. Only index the org's own products, not ecosystem plugins. Add and pause low-value sources rather than omitting them entirely.

## Output

Keep output concise — focus on actions and results.

IMPORTANT: At the end of discovery, write a JSON state file using the write tool to /tmp/discovery-state.json with this schema:
{
  "product": "<company name>",
  "domain": "<discovered domain or null>",
  "githubOrg": "<discovered GitHub org or null>",
  "startedAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>",
  "status": "awaiting_review",
  "sources": [
    {
      "url": "<source url>",
      "type": "github|scrape|feed",
      "slug": "<slug from releases add>",
      "label": "<human-readable label>",
      "confidence": "high|medium|low",
      "validated": true/false,
      "validationError": "<error message if validation failed>",
      "releaseCount": <number>,
      "contentDepth": "full|summary-only"
    }
  ]
}`;
}

// ── CLI execution ─────────────────────────────────────────────────

const CLI_CMD = process.env.RELEASED_CLI_CMD ?? "releases";

async function executeCLI(command: string): Promise<string> {
  const fullCmd = `${CLI_CMD} ${command}`;
  logger.debug(`[managed-agents] $ ${fullCmd}`);

  try {
    const result = await $`bash -c ${fullCmd}`.quiet().nothrow();
    const stdout = result.stdout.toString().trim();
    const stderr = result.stderr.toString().trim();

    if (result.exitCode !== 0) {
      return `Command failed (exit ${result.exitCode}):\n${stderr || stdout}`;
    }
    return stdout || "(no output)";
  } catch (err) {
    return `Command error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Agent/Environment setup ───────────────────────────────────────

async function ensureAgentAndEnv(
  client: Anthropic,
): Promise<{ agentId: string; agentVersion: number; environmentId: string }> {
  const cached = loadCachedConfig();
  if (cached) {
    logger.debug(`[managed-agents] Using cached agent=${cached.agentId} env=${cached.environmentId}`);
    return cached;
  }

  logger.info("[managed-agents] Creating agent and environment (first run)...");

  const agent = await client.beta.agents.create({
    name: "Released Discovery Agent",
    model: "claude-haiku-4-5",
    system: buildSystemPrompt(),
    tools: [
      { type: "agent_toolset_20260401", default_config: { enabled: true } },
      {
        type: "custom",
        name: "releases_cli",
        description:
          "Execute a Released CLI command. Manages changelog sources, orgs, products. Use --json for structured output. Do NOT fetch without --dry-run unless told to persist.",
        input_schema: {
          type: "object" as const,
          properties: {
            command: {
              type: "string",
              description:
                'CLI command and arguments without the "releases" prefix. Example: "list --json" or "fetch my-source --dry-run"',
            },
          },
          required: ["command"],
        },
      },
    ],
  });

  const environment = await client.beta.environments.create({
    name: `released-discovery-${Date.now()}`,
    config: {
      type: "cloud",
      networking: { type: "unrestricted" },
    },
  });

  const cfg: ManagedAgentConfig = {
    agentId: agent.id,
    agentVersion: agent.version as number,
    environmentId: environment.id,
    updatedAt: new Date().toISOString(),
  };

  saveCachedConfig(cfg);
  logger.info(`[managed-agents] Agent ${agent.id} and environment ${environment.id} created and cached`);

  return cfg;
}

// ── Run discovery ─────────────────────────────────────────────────

export async function runManagedDiscovery(options: DiscoveryOptions): Promise<DiscoveryState> {
  const apiKey = config.anthropicApiKey();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for managed agents discovery");
  }

  const client = new Anthropic({ apiKey });
  const { agentId, agentVersion, environmentId } = await ensureAgentAndEnv(client);

  // Build the prompt
  const hints: string[] = [];
  if (options.domain) hints.push(`Their website is ${options.domain}.`);
  if (options.githubOrg) hints.push(`Their GitHub organization is ${options.githubOrg}.`);
  const hintStr = hints.length > 0 ? " " + hints.join(" ") : "";

  const prompt = `Find and evaluate changelog sources for "${options.company}".${hintStr} Check what we already have, discover new sources, validate them with dry-run fetches, and write the discovery state file. Do not persist any fetches — dry-run only. For feed sources, note in the state file whether content appears sparse (short summaries) so enrichment can be run after fetching.`;

  // Create session
  const session = await client.beta.sessions.create({
    agent: { type: "agent", id: agentId, version: agentVersion },
    environment_id: environmentId,
    title: `Discovery: ${options.company}`,
  });

  logger.info(`[managed-agents] Session ${session.id} created`);

  // Stream-first: open stream, then send message
  const stream = await client.beta.sessions.events.stream(session.id);

  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: prompt }],
      },
    ],
  });

  // Process events
  for await (const event of stream) {
    switch (event.type) {
      case "agent.message":
        for (const block of (event as any).content ?? []) {
          if (block.type === "text") {
            options.onProgress?.(block.text);
          }
        }
        break;

      case "agent.tool_use":
        options.onToolUse?.((event as any).name, undefined);
        break;

      case "agent.custom_tool_use": {
        const toolEvent = event as any;
        const input = toolEvent.input as { command?: string };
        const command = input?.command ?? "";

        options.onToolUse?.("releases_cli", command);

        const result = await executeCLI(command);

        // Truncate very large outputs
        const maxLen = 50_000;
        const truncated =
          result.length > maxLen
            ? result.slice(0, maxLen) + `\n\n[output truncated — ${result.length} total chars]`
            : result;

        await client.beta.sessions.events.send(session.id, {
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: toolEvent.id,
              content: [{ type: "text", text: truncated }],
            },
          ],
        });
        break;
      }

      case "session.status_idle": {
        const stopReason = (event as any).stop_reason;
        if (stopReason?.type === "requires_action") continue;
        break;
      }

      case "session.status_terminated":
        break;

      case "session.error":
        logger.error(`[managed-agents] Session error: ${JSON.stringify(event)}`);
        break;
    }

    // Terminal conditions
    if (event.type === "session.status_terminated") break;
    if (
      event.type === "session.status_idle" &&
      (event as any).stop_reason?.type !== "requires_action"
    ) {
      break;
    }
  }

  // Fetch usage for logging
  try {
    const finalSession = await client.beta.sessions.retrieve(session.id);
    const usage = finalSession.usage as Record<string, unknown> | undefined;
    if (usage) {
      logger.info(`[managed-agents] Session usage: ${JSON.stringify(usage)}`);
    }
  } catch {
    // Non-critical
  }

  // Archive session
  try {
    await new Promise((r) => setTimeout(r, 300)); // post-idle race
    await client.beta.sessions.archive(session.id);
  } catch {
    // Non-critical
  }

  // Read state file — the agent writes it via the container's write tool
  // We need to read it via a CLI command since the file is in the container
  const stateOutput = await executeCLI("--internal-read-state 2>/dev/null || echo '{}'");

  // Fallback: the agent may have written state via releases_cli tool instead
  // Try parsing what we got, or return minimal state
  const now = new Date().toISOString();
  try {
    // The agent might have written the state file via the container write tool,
    // which we can't access. But the agent also builds up state in its messages.
    // For now, return minimal state — Phase 3 will improve this.
    const state: DiscoveryState = {
      product: options.company,
      domain: options.domain,
      githubOrg: options.githubOrg,
      startedAt: now,
      updatedAt: now,
      status: "awaiting_review",
      sources: [],
    };
    return state;
  } catch {
    return {
      product: options.company,
      domain: options.domain,
      githubOrg: options.githubOrg,
      startedAt: now,
      updatedAt: now,
      status: "awaiting_review",
      sources: [],
    };
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors in the new file. The module imports `DiscoveryState` and `DiscoveryOptions` from `released.ts` which already exports them.

- [ ] **Step 3: Commit**

```bash
git add src/agent/managed-discovery.ts
git commit -m "feat: add managed agents discovery module

Parallel path to the existing Claude Agent SDK discovery.
CLI operations execute host-side via custom tools — secrets
never enter the Managed Agent container."
```

---

### Task 3: Wire up the onboard command

**Files:**
- Modify: `src/cli/commands/onboard.ts`

- [ ] **Step 1: Add the `--managed-agents` flag and import**

At the top of `src/cli/commands/onboard.ts`, add the import:
```typescript
import { runManagedDiscovery } from "../../agent/managed-discovery.js";
```

Add `managedAgents?: boolean` to the `OnboardOpts` interface:
```typescript
interface OnboardOpts {
  domain?: string;
  githubOrg?: string;
  json?: boolean;
  remote?: boolean;
  local?: boolean;
  managedAgents?: boolean;
}
```

Add the CLI option after the `--local` option (before `.addHelpText`):
```typescript
.option("--managed-agents", "Use Anthropic Managed Agents instead of Cloudflare Sandbox")
```

- [ ] **Step 2: Add the managed agents execution path**

In the `.action()` handler, add the managed agents branch before the existing remote/local decision. Replace the action body (lines 38-49) with:

```typescript
.action(async (company: string, opts: OnboardOpts) => {
  if (opts.remote && opts.local) {
    logger.error("Cannot specify both --remote and --local");
    process.exit(1);
  }

  if (opts.managedAgents) {
    await runManagedAgentsDiscovery(company, opts);
  } else if (shouldUseRemote(opts)) {
    await runRemoteDiscovery(company, opts);
  } else {
    await runLocalDiscovery(company, opts);
  }
});
```

Add the new function after `runLocalDiscovery`:

```typescript
async function runManagedAgentsDiscovery(company: string, opts: OnboardOpts): Promise<void> {
  if (!opts.json) {
    process.stderr.write(
      chalk.bold(`Onboarding "${company}"`) +
        chalk.gray(" — using Anthropic Managed Agents...\n\n"),
    );
  }

  let lastToolName = "";

  const state = await runManagedDiscovery({
    company,
    domain: opts.domain,
    githubOrg: opts.githubOrg,
    onProgress: opts.json ? undefined : (text) => {
      process.stderr.write(chalk.dim(text));
    },
    onToolUse: opts.json ? undefined : (toolName, command) => {
      if (toolName === "releases_cli" && command) {
        const display = command.length > 120 ? command.slice(0, 117) + "..." : command;
        process.stderr.write(chalk.gray(`  $ releases ${display}\n`));
      } else if (toolName !== lastToolName) {
        process.stderr.write(chalk.gray(`  [${toolName}]\n`));
      }
      lastToolName = toolName;
    },
  });

  if (opts.json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  printSummary(state);
}
```

- [ ] **Step 3: Update the help text**

Add a managed agents example to the `.addHelpText` block:
```
  releases onboard "Acme" --managed-agents
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Smoke test**

Run: `bun src/index.ts onboard --help`
Expected: Shows `--managed-agents` in the options list.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/onboard.ts
git commit -m "feat: add --managed-agents flag to onboard command"
```

---

### Task 4: End-to-end test

- [ ] **Step 1: Run managed agents discovery for a known company**

Run: `bun src/index.ts onboard "Resend" --domain resend.com --managed-agents`
Expected: Agent discovers sources, validates with dry-runs, prints summary. Should complete in under 2 minutes.

- [ ] **Step 2: Run with --json flag**

Run: `bun src/index.ts onboard "Resend" --domain resend.com --managed-agents --json`
Expected: Outputs valid JSON to stdout with DiscoveryState shape.

- [ ] **Step 3: Verify existing path still works**

Run: `bun src/index.ts onboard "Resend" --domain resend.com --local`
Expected: Uses existing Agent SDK path, same behavior as before.

- [ ] **Step 4: Document results**

Update `.context/2026-04-09-managed-agents-spike.md` with Phase 2 test results: timing, cost comparison, any issues found.

---

### Task 5: Handle state file retrieval (known limitation)

The current implementation has a limitation: the agent writes `/tmp/discovery-state.json` inside the Managed Agent container, but we can't read container files directly. The `runManagedDiscovery` function currently returns minimal state.

- [ ] **Step 1: Add a `releases_read_state` custom tool**

In `managed-discovery.ts`, add a second custom tool to the agent's tools array:

```typescript
{
  type: "custom",
  name: "releases_report_state",
  description:
    "Report the final discovery state as JSON. Call this at the end of discovery instead of writing to a file.",
  input_schema: {
    type: "object" as const,
    properties: {
      state: {
        type: "object",
        description: "The complete discovery state JSON object",
      },
    },
    required: ["state"],
  },
},
```

- [ ] **Step 2: Handle the tool call to capture state**

Add a `capturedState` variable before the event loop, and capture state from the custom tool:

```typescript
let capturedState: DiscoveryState | null = null;

// ... in the event loop, in the agent.custom_tool_use handler:
if (toolEvent.name === "releases_report_state") {
  try {
    capturedState = toolEvent.input.state as DiscoveryState;
  } catch {
    // Non-critical
  }
  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: toolEvent.id,
        content: [{ type: "text", text: "State captured successfully." }],
      },
    ],
  });
  break; // or continue, depending on position
}
```

- [ ] **Step 3: Update the system prompt**

Add to the system prompt, replacing the state file instruction:

```
IMPORTANT: At the end of discovery, call the releases_report_state tool with the complete discovery state JSON (instead of writing to a file).
```

- [ ] **Step 4: Return captured state**

Replace the state file reading block at the end of `runManagedDiscovery` with:

```typescript
if (capturedState) {
  return capturedState;
}

// Fallback minimal state
const now = new Date().toISOString();
return {
  product: options.company,
  domain: options.domain,
  githubOrg: options.githubOrg,
  startedAt: now,
  updatedAt: now,
  status: "awaiting_review",
  sources: [],
};
```

- [ ] **Step 5: Test state capture**

Run: `bun src/index.ts onboard "Resend" --domain resend.com --managed-agents --json`
Expected: JSON output includes populated `sources` array with discovered sources.

- [ ] **Step 6: Commit**

```bash
git add src/agent/managed-discovery.ts
git commit -m "feat: capture discovery state via custom tool instead of file I/O"
```
