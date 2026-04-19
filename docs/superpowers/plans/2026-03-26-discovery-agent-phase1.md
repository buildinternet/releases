# Discovery Agent — Phase 1 (Local Agent) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalize the Agent SDK PoC into the main codebase with a CLI command (`released onboard <company>`) and a Cloudflare Browser Rendering MCP server for JS-rendered pages.

**Architecture:** The discovery agent uses the Anthropic Agent SDK (`@anthropic-ai/claude-agent-sdk`) to drive Claude through an iterative tool loop, using the Released CLI as the primary tool. A Haiku-based subagent handles per-source validation via `fetch --dry-run`. A lightweight MCP server wraps Cloudflare Browser Rendering for JS-heavy pages.

**Tech Stack:** Bun, TypeScript, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, Cloudflare Browser Rendering REST API

---

## File Structure

| Action | File                                  | Responsibility                                                                                                           |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Create | `src/agent/discovery.ts`              | Discovery agent: system prompt, tool config, Agent SDK `query()` call, message streaming, state file output              |
| Create | `src/agent/mcp-cloudflare-browser.ts` | MCP server: wraps CF Browser Rendering `/markdown` and `/content` endpoints as `render_markdown` and `render_html` tools |
| Create | `src/cli/commands/onboard.ts`         | CLI command: `released onboard <company>` — parses options, invokes discovery agent, streams progress, prints summary    |
| Modify | `src/cli/program.ts`                  | Register the new `onboard` command                                                                                       |
| Modify | `package.json`                        | Add `@anthropic-ai/claude-agent-sdk` dependency                                                                          |

---

## Task 1: Add Agent SDK dependency

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Install the Agent SDK**

```bash
cd /Users/zachdunn/Code/released && bun add @anthropic-ai/claude-agent-sdk
```

- [ ] **Step 2: Verify installation**

```bash
cd /Users/zachdunn/Code/released && bun --eval "import { query } from '@anthropic-ai/claude-agent-sdk'; console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "Add @anthropic-ai/claude-agent-sdk dependency"
```

---

## Task 2: Cloudflare Browser Rendering MCP server

**Files:**

- Create: `src/agent/mcp-cloudflare-browser.ts`

This MCP server runs as a stdio subprocess. The Agent SDK spawns it via `mcpServers` config. It exposes two tools: `render_markdown` and `render_html`.

- [ ] **Step 1: Create the MCP server**

```typescript
// src/agent/mcp-cloudflare-browser.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CF_REJECT_RESOURCE_TYPES = ["image", "media", "font", "stylesheet"];

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

if (!accountId || !apiToken) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  process.exit(1);
}

const server = new McpServer({
  name: "cloudflare-browser",
  version: "1.0.0",
});

server.tool(
  "render_markdown",
  "Render a URL via Cloudflare Browser Rendering and return the page content as markdown. Use this when WebFetch returns empty or skeleton content from JS-rendered pages.",
  {
    url: z.string().url().describe("The URL to render"),
    waitUntil: z
      .enum(["load", "networkidle2"])
      .default("networkidle2")
      .describe("When to consider the page loaded"),
  },
  async ({ url, waitUntil }) => {
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/markdown`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        rejectResourceTypes: CF_REJECT_RESOURCE_TYPES,
        gotoOptions: { waitUntil },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        content: [{ type: "text" as const, text: `Error ${res.status}: ${body}` }],
        isError: true,
      };
    }

    const data = (await res.json()) as { title?: string; markdown?: string; text?: string };
    const markdown = data.markdown ?? data.text ?? "";

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ markdown, title: data.title ?? "", url }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "render_html",
  "Render a URL and return the fully-rendered HTML after JavaScript execution. Use when you need to inspect the post-hydration DOM structure.",
  {
    url: z.string().url().describe("The URL to render"),
    waitUntil: z
      .enum(["load", "networkidle2"])
      .default("networkidle2")
      .describe("When to consider the page loaded"),
  },
  async ({ url, waitUntil }) => {
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/content`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        rejectResourceTypes: CF_REJECT_RESOURCE_TYPES,
        gotoOptions: { waitUntil },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        content: [{ type: "text" as const, text: `Error ${res.status}: ${body}` }],
        isError: true,
      };
    }

    const html = await res.text();

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ html: html.slice(0, 50000), url }, null, 2),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Verify it starts without errors (will fail without CF creds but should parse)**

```bash
cd /Users/zachdunn/Code/released && npx tsc --noEmit src/agent/mcp-cloudflare-browser.ts 2>&1 || true
```

Type-check should pass (or only show errors unrelated to this file).

- [ ] **Step 3: Commit**

```bash
git add src/agent/mcp-cloudflare-browser.ts
git commit -m "Add Cloudflare Browser Rendering MCP server for discovery agent"
```

---

## Task 3: Discovery agent module

**Files:**

- Create: `src/agent/discovery.ts`

This is the core agent module. It wraps the Agent SDK `query()` call with the system prompt, tool configuration, subagent definition, and streaming logic.

- [ ] **Step 1: Create the discovery agent module**

```typescript
// src/agent/discovery.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "path";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";

export interface DiscoveredSource {
  url: string;
  type: "github" | "scrape" | "feed";
  slug: string;
  label: string;
  confidence: "high" | "medium" | "low";
  validated: boolean;
  validationError?: string;
  releaseCount?: number;
  duplicateOf?: string;
  approved?: boolean;
  fetched?: boolean;
}

export interface DiscoveryState {
  product: string;
  domain?: string;
  githubOrg?: string;
  startedAt: string;
  updatedAt: string;
  status: "discovering" | "awaiting_review" | "approved" | "fetching" | "complete";
  sources: DiscoveredSource[];
  agentSessionId?: string;
  costUsd?: number;
  turns?: number;
}

export interface DiscoveryOptions {
  company: string;
  domain?: string;
  githubOrg?: string;
  json?: boolean;
  /** Called with each assistant text chunk for progress display */
  onProgress?: (text: string) => void;
  /** Called with each tool use for progress display */
  onToolUse?: (toolName: string, command?: string) => void;
}

function buildSystemPrompt(projectRoot: string): string {
  return `You are a changelog discovery agent for the "Released" tool. Your job is to find and onboard changelog sources for a given company or product.

You have access to the Released CLI at: bun ${projectRoot}/src/index.ts

Available commands:
- list: Show all indexed sources (use --json for machine-readable output)
- discover <domain>: Probe a domain for changelog URLs, feeds, and GitHub repos
- add <url> --name <name> --type <type>: Add a new source (types: github, scrape, feed)
- add --batch <file>: Add multiple sources from a JSON file (array of {url, name, type})
- fetch <slug> --dry-run: Test fetching a source without persisting
- remove <slug1> <slug2> ...: Remove sources by slug

Your workflow:
1. Check what sources already exist with "list --json"
2. Use web search to find the company's main website, changelog pages, and GitHub organization
3. Use "discover" on the company's domain to find changelog surfaces
4. For any promising URLs found via search or discover, add them as sources
5. Use batch operations ("add --batch") when adding multiple sources at once — write the JSON array to a temp file, then pass it
6. Delegate validation to the "source-validator" subagent for each source (it runs "fetch --dry-run" and evaluates results)
7. Remove sources that don't extract well or are duplicates of better sources
8. Report your findings

When WebFetch returns empty or skeleton content (JS-rendered pages), use the render_markdown MCP tool to get the fully-rendered content.

Be methodical. If a source doesn't extract well, try a different URL or type.
Do NOT actually fetch (without --dry-run) unless explicitly told to.
Keep your output concise — focus on actions and results.

IMPORTANT: At the end of your work, write a JSON state file to /tmp/discovery-state.json with this exact schema:
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
      "slug": "<slug from released add>",
      "label": "<human-readable label>",
      "confidence": "high|medium|low",
      "validated": true/false,
      "validationError": "<error message if validation failed>",
      "releaseCount": <number of releases found in dry-run>,
      "duplicateOf": "<slug if this overlaps another source>"
    }
  ]
}`;
}

export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryState> {
  const projectRoot = resolve(import.meta.dir, "../..");

  const apiKey = config.anthropicApiKey();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required to run the discovery agent");
  }

  const model = config.agentModel();
  const systemPrompt = buildSystemPrompt(projectRoot);

  // Build the user prompt with optional hints
  const hints: string[] = [];
  if (options.domain) hints.push(`Their website is ${options.domain}.`);
  if (options.githubOrg) hints.push(`Their GitHub organization is ${options.githubOrg}.`);
  const hintStr = hints.length > 0 ? " " + hints.join(" ") : "";

  const prompt = `Find and evaluate changelog sources for "${options.company}".${hintStr} Check what we already have, discover new sources, validate them with dry-run fetches, and write the discovery state file. Do not persist any fetches — dry-run only.`;

  // Build MCP server config for Cloudflare Browser Rendering
  const mcpServers: Record<string, object> = {};
  if (config.cloudflareAccountId() && config.cloudflareApiToken()) {
    mcpServers["cloudflare-browser"] = {
      type: "stdio",
      command: "bun",
      args: [resolve(projectRoot, "src/agent/mcp-cloudflare-browser.ts")],
      env: {
        CLOUDFLARE_ACCOUNT_ID: config.cloudflareAccountId(),
        CLOUDFLARE_API_TOKEN: config.cloudflareApiToken(),
      },
    };
  }

  logger.info(`Starting discovery agent for "${options.company}" (model: ${model})`);

  const conversation = query({
    prompt,
    options: {
      model,
      cwd: projectRoot,
      systemPrompt,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 30,
      maxBudgetUsd: 2.0,
      tools: { type: "preset", preset: "claude_code" },
      allowedTools: ["Bash", "Read", "Write", "Glob", "Grep", "WebSearch", "WebFetch"],
      mcpServers,
      agents: {
        "source-validator": {
          description:
            "Validates a single changelog source by running fetch --dry-run and evaluating the results. Invoke with the source slug.",
          prompt: `You validate Released changelog sources. Given a source slug, run:
  bun ${projectRoot}/src/index.ts fetch <slug> --dry-run

Evaluate the output:
- Did it find releases? How many?
- Do the releases have titles, dates, and content?
- Is this a real changelog/release page or something unrelated?

Report back with: slug, release count, quality assessment (good/partial/bad), and any issues.`,
          tools: ["Bash", "Read"],
          model: "haiku",
          maxTurns: 5,
        },
      },
    },
  });

  // Stream messages
  for await (const message of conversation) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          options.onProgress?.(block.text);
        } else if (block.type === "tool_use") {
          const command =
            block.name === "Bash" && typeof block.input === "object" && block.input !== null
              ? ((block.input as Record<string, unknown>).command as string | undefined)
              : undefined;
          options.onToolUse?.(block.name, command);
        }
      }
    } else if (message.type === "result") {
      logger.info(
        `Discovery agent complete — session: ${message.session_id}, cost: $${((message as any).cost_usd ?? 0).toFixed(4)}, turns: ${(message as any).num_turns ?? "?"}`,
      );
    }
  }

  // Read the state file the agent should have written
  const stateFile = "/tmp/discovery-state.json";
  try {
    const raw = await Bun.file(stateFile).text();
    const state: DiscoveryState = JSON.parse(raw);
    return state;
  } catch {
    logger.warn("Agent did not write a valid discovery state file — returning minimal state");
    return {
      product: options.company,
      domain: options.domain,
      githubOrg: options.githubOrg,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "awaiting_review",
      sources: [],
    };
  }
}
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/zachdunn/Code/released && npx tsc --noEmit
```

Expected: No errors in `src/agent/discovery.ts`. Fix any issues.

- [ ] **Step 3: Commit**

```bash
git add src/agent/discovery.ts
git commit -m "Add discovery agent module wrapping Agent SDK"
```

---

## Task 4: CLI onboard command

**Files:**

- Create: `src/cli/commands/onboard.ts`
- Modify: `src/cli/program.ts`

- [ ] **Step 1: Create the onboard command**

```typescript
// src/cli/commands/onboard.ts
import { Command } from "commander";
import chalk from "chalk";
import { runDiscovery, type DiscoveryState } from "../../agent/discovery.js";
import { logger } from "../../lib/logger.js";

export function registerOnboardCommand(program: Command) {
  program
    .command("onboard")
    .description("Discover and onboard changelog sources for a company using AI agent")
    .argument("<company>", "Company or product name to discover sources for")
    .option("--domain <domain>", "Seed the agent with the company's domain")
    .option("--github-org <org>", "Seed the agent with the company's GitHub organization")
    .option("--json", "Output results as JSON")
    .action(
      async (company: string, opts: { domain?: string; githubOrg?: string; json?: boolean }) => {
        if (!opts.json) {
          process.stderr.write(
            chalk.bold(`Onboarding "${company}"`) +
              chalk.gray(" — discovery agent is running...\n\n"),
          );
        }

        let lastToolName = "";

        const state = await runDiscovery({
          company,
          domain: opts.domain,
          githubOrg: opts.githubOrg,
          json: opts.json,
          onProgress: (text) => {
            if (!opts.json) {
              process.stderr.write(chalk.dim(text));
            }
          },
          onToolUse: (toolName, command) => {
            if (opts.json) return;
            if (toolName === "Bash" && command) {
              // Show CLI commands the agent runs (truncate long ones)
              const display = command.length > 120 ? command.slice(0, 117) + "..." : command;
              process.stderr.write(chalk.gray(`  $ ${display}\n`));
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

        // Print summary
        printSummary(state);
      },
    );
}

function printSummary(state: DiscoveryState): void {
  const { sources } = state;

  process.stderr.write("\n");
  console.log(chalk.bold(`Discovery results for ${state.product}\n`));

  if (state.domain) console.log(chalk.gray(`  Domain: ${state.domain}`));
  if (state.githubOrg) console.log(chalk.gray(`  GitHub: ${state.githubOrg}`));

  if (sources.length === 0) {
    console.log(chalk.yellow("\n  No sources discovered."));
    return;
  }

  const validated = sources.filter((s) => s.validated);
  const failed = sources.filter((s) => s.validationError);

  console.log(
    chalk.gray(
      `  ${sources.length} source(s) found, ${validated.length} validated, ${failed.length} failed\n`,
    ),
  );

  for (const s of sources) {
    const conf =
      s.confidence === "high"
        ? chalk.green(s.confidence)
        : s.confidence === "medium"
          ? chalk.yellow(s.confidence)
          : chalk.red(s.confidence);
    const status = s.validationError
      ? chalk.red("failed")
      : s.validated
        ? chalk.green(`${s.releaseCount ?? 0} releases`)
        : chalk.gray("not validated");
    const dup = s.duplicateOf ? chalk.dim(` (dup of ${s.duplicateOf})`) : "";

    console.log(`  ${chalk.cyan(s.slug)} ${chalk.dim(s.type)} ${conf} — ${status}${dup}`);
    console.log(chalk.dim(`    ${s.url}`));
  }

  console.log(chalk.dim(`\n  Status: ${state.status}`));
}
```

- [ ] **Step 2: Register the command in program.ts**

Add import and registration to `src/cli/program.ts`:

```typescript
// Add to imports:
import { registerOnboardCommand } from "./commands/onboard.js";

// Add to registrations (after registerFetchLogCommand):
registerOnboardCommand(program);
```

- [ ] **Step 3: Verify the command shows up in help**

```bash
cd /Users/zachdunn/Code/released && bun src/index.ts onboard --help
```

Expected output should show:

```
Usage: released onboard [options] <company>

Discover and onboard changelog sources for a company using AI agent

Arguments:
  company                  Company or product name to discover sources for

Options:
  --domain <domain>        Seed the agent with the company's domain
  --github-org <org>       Seed the agent with the company's GitHub organization
  --json                   Output results as JSON
  -h, --help               display help for command
```

- [ ] **Step 4: Type-check the full project**

```bash
cd /Users/zachdunn/Code/released && npx tsc --noEmit
```

Expected: No errors. Fix any issues.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/onboard.ts src/cli/program.ts
git commit -m "Add onboard CLI command for AI-driven source discovery"
```

---

## Task 5: Integration test — dry run

This is a manual verification that the full pipeline works end-to-end.

- [ ] **Step 1: Verify help output**

```bash
cd /Users/zachdunn/Code/released && bun src/index.ts onboard --help
```

- [ ] **Step 2: Run a real discovery (optional, requires ANTHROPIC_API_KEY)**

```bash
cd /Users/zachdunn/Code/released && bun src/index.ts onboard "Resend" --domain resend.com
```

Watch stderr for agent progress. On completion, verify the JSON state was written and the summary prints correctly.

- [ ] **Step 3: Test JSON output mode (optional, requires ANTHROPIC_API_KEY)**

```bash
cd /Users/zachdunn/Code/released && bun src/index.ts onboard "Resend" --domain resend.com --json
```

Should output valid JSON to stdout with no progress on stderr.

- [ ] **Step 4: Final commit with any fixes**

If any adjustments were needed during integration testing, commit them:

```bash
git add -A
git commit -m "Fix integration issues found during discovery agent testing"
```
