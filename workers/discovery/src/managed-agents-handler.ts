/**
 * Managed Agents discovery handler for the worker context.
 *
 * Mirrors the orchestration logic from src/agent/managed-discovery.ts
 * but runs in a Cloudflare Worker (no Bun, no subprocess). Uses the
 * HTTP executor to route CLI commands through the API worker.
 */

import type { Env, OnboardRequest } from "./types.js";
import { createHTTPExecutor } from "./http-executor.js";

const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

interface ManagedDiscoveryResult {
  sessionId: string;
  state: Record<string, unknown> | null;
  error?: string;
}

/**
 * Run managed agents discovery. Returns when complete.
 *
 * Calls Anthropic's Managed Agents API directly, handling custom tool
 * calls via the HTTP executor (routes through the API worker).
 * Posts status events to StatusHub for dashboard visibility.
 */
export async function runManagedAgentsDiscovery(
  params: OnboardRequest,
  env: Env,
  sessionId: string,
): Promise<ManagedDiscoveryResult> {
  const anthropicApiKey = await env.ANTHROPIC_API_KEY.get();
  if (!anthropicApiKey) {
    return { sessionId, state: null, error: "ANTHROPIC_API_KEY not configured" };
  }

  const releasedApiKey = await env.RELEASED_API_KEY.get();
  const fetcher = env.API_WORKER ?? {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(
        typeof input === "string" ? input.replace("https://api", env.RELEASED_API_URL.replace(/\/+$/, "")) : input,
        init,
      ),
  };

  const executor = createHTTPExecutor({
    fetcher,
    apiKey: releasedApiKey,
  });

  // Notify StatusHub: session started
  await notifyStatusHub(env, {
    type: "session:start",
    sessionId,
    company: params.company,
  });

  try {
    // Import Anthropic SDK dynamically — the worker bundles it
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: anthropicApiKey });

    // Create agent + session
    const agentModel = "claude-sonnet-4-6"; // Use sonnet for cost efficiency in remote mode
    const systemPrompt = buildSystemPrompt();

    const agent = await (client.beta.agents as any).create({
      name: "Released Discovery Agent",
      model: agentModel,
      system: systemPrompt,
      tools: [
        { type: "agent_toolset_20260401", default_config: { enabled: true } },
        {
          type: "custom",
          name: "releases_cli",
          description: "Execute a Released CLI command. Use --json for structured output. Do NOT fetch without --dry-run unless told to persist.",
          input_schema: {
            type: "object",
            properties: {
              command: { type: "string", description: 'CLI command without the "releases" prefix.' },
            },
            required: ["command"],
          },
        },
        {
          type: "custom",
          name: "releases_report_state",
          description: "Report the final discovery state as JSON.",
          input_schema: {
            type: "object",
            properties: {
              state: { type: "object", description: "The complete discovery state JSON." },
            },
            required: ["state"],
          },
        },
      ],
    });

    const environment = await (client.beta.environments as any).create({
      name: `released-discovery-${Date.now()}`,
      config: { type: "cloud", networking: { type: "unrestricted" } },
    });

    const session = await (client.beta.sessions as any).create({
      agent: { type: "agent", id: agent.id, version: agent.version },
      environment_id: environment.id,
      title: `Discovery: ${params.company}`,
    });

    // Build user prompt
    const hints: string[] = [];
    if (params.domain) hints.push(`Their website is ${params.domain}.`);
    if (params.githubOrg) hints.push(`Their GitHub organization is ${params.githubOrg}.`);
    const hintStr = hints.length > 0 ? " " + hints.join(" ") : "";
    const prompt = `Find and evaluate changelog sources for "${params.company}".${hintStr} Check what we already have, discover new sources, validate them with dry-run fetches, and write the discovery state file. Do not persist any fetches — dry-run only. For feed sources, note in the state file whether content appears sparse (short summaries) so enrichment can be run after fetching.`;

    // Stream events
    const stream = await (client.beta.sessions.events as any).stream(session.id);
    await (client.beta.sessions.events as any).send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
    });

    let capturedState: Record<string, unknown> | null = null;
    let done = false;
    let toolCallCount = 0;
    const deadline = Date.now() + SESSION_TIMEOUT_MS;
    const timeoutId = setTimeout(() => {
      try { stream.controller.abort(); } catch { /* closed */ }
    }, SESSION_TIMEOUT_MS);

    try {
      for await (const event of stream) {
        if (Date.now() > deadline) break;

        switch (event.type) {
          case "agent.custom_tool_use": {
            const toolEvent = event as any;

            if (toolEvent.name === "releases_report_state") {
              const reported = toolEvent.input?.state;
              if (reported && typeof reported === "object") {
                capturedState = reported as Record<string, unknown>;
                capturedState["updatedAt"] = new Date().toISOString();
              }
              await (client.beta.sessions.events as any).send(session.id, {
                events: [{
                  type: "user.custom_tool_result",
                  custom_tool_use_id: toolEvent.id,
                  content: [{ type: "text", text: "State captured successfully." }],
                }],
              });
              continue;
            }

            if (toolEvent.name === "releases_cli") {
              const command = toolEvent.input?.command ?? "";
              toolCallCount++;

              await notifyStatusHub(env, {
                type: "session:progress",
                sessionId,
                company: params.company,
                step: "discovery",
                currentAction: `releases ${command}`,
                toolCalls: toolCallCount,
              });

              const result = await executor(command);
              const maxLen = 50_000;
              const truncated = result.length > maxLen
                ? result.slice(0, maxLen) + `\n\n[output truncated — ${result.length} total chars]`
                : result;

              await (client.beta.sessions.events as any).send(session.id, {
                events: [{
                  type: "user.custom_tool_result",
                  custom_tool_use_id: toolEvent.id,
                  content: [{ type: "text", text: truncated }],
                }],
              });
            } else {
              // Unknown tool
              await (client.beta.sessions.events as any).send(session.id, {
                events: [{
                  type: "user.custom_tool_result",
                  custom_tool_use_id: toolEvent.id,
                  content: [{ type: "text", text: "Unknown tool" }],
                }],
              });
            }
            break;
          }

          case "session.status_idle":
            if ((event as any).stop_reason?.type === "requires_action") continue;
            done = true;
            break;

          case "session.status_terminated":
            done = true;
            break;

          case "session.error":
            console.error(`[managed-agents] Session error: ${JSON.stringify(event)}`);
            break;
        }

        if (done) break;
      }
    } finally {
      clearTimeout(timeoutId);
      try { stream.controller.abort(); } catch { /* closed */ }
    }

    // Archive
    try { await (client.beta.sessions as any).archive(session.id); } catch { /* non-critical */ }
    try { await (client.beta.agents as any).archive(agent.id); } catch { /* non-critical */ }

    if (capturedState) {
      capturedState["agentSessionId"] = session.id;
      await notifyStatusHub(env, {
        type: "session:complete",
        sessionId,
        company: params.company,
        sourcesFound: Array.isArray(capturedState["sources"]) ? (capturedState["sources"] as unknown[]).length : 0,
        result: capturedState,
      });
      return { sessionId, state: capturedState };
    }

    await notifyStatusHub(env, {
      type: "session:error",
      sessionId,
      company: params.company,
      error: "Agent did not report discovery state",
    });
    return { sessionId, state: null, error: "Agent did not report discovery state" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await notifyStatusHub(env, {
      type: "session:error",
      sessionId,
      company: params.company,
      error: message,
    });
    return { sessionId, state: null, error: message };
  }
}

// ── StatusHub notification ──

async function notifyStatusHub(env: Env, event: Record<string, unknown>): Promise<void> {
  try {
    const apiKey = await env.RELEASED_API_KEY.get();
    const url = `${env.RELEASED_API_URL}/v1/status/event`;
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(event),
    });
  } catch {
    // Non-critical
  }
}

// ── System prompt (matches src/agent/managed-discovery.ts) ──

const CATEGORIES = [
  "ai", "cloud", "database", "design", "developer-tools",
  "devops", "framework", "infrastructure", "observability", "security",
];

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

IMPORTANT: At the end of discovery, call the releases_report_state tool with the complete discovery state JSON object (do NOT write to a file). The state object must include: product, domain, githubOrg, startedAt, updatedAt, status, and sources array. Use this schema:
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
