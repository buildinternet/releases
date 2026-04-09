/**
 * Durable Object for managed agents discovery sessions.
 *
 * Cloudflare Workers have CPU time limits that a managed agents session
 * exceeds (~60-120s of streaming). Durable Objects reset their 30s
 * wall-clock timer on each I/O operation (API calls, fetches), making
 * them suitable for long-running I/O-bound workloads.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types.js";
import { createHTTPExecutor } from "./http-executor.js";

interface SessionParams {
  company: string;
  domain?: string;
  githubOrg?: string;
  sessionId: string;
}

const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

const CATEGORIES = [
  "ai", "cloud", "database", "design", "developer-tools",
  "devops", "framework", "infrastructure", "observability", "security",
];

export class ManagedAgentsSession extends DurableObject<Env> {

  async startDiscovery(params: SessionParams): Promise<void> {
    // Store params and schedule via alarm for immediate execution
    await this.ctx.storage.put("params", params);
    await this.ctx.storage.put("status", "running");
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const status = await this.ctx.storage.get<string>("status");
    if (status !== "running") return;

    const params = await this.ctx.storage.get<SessionParams>("params");
    if (!params) return;

    await this.runDiscovery(params);
  }

  async getStatus(): Promise<Record<string, unknown>> {
    const map = await this.ctx.storage.get(["status", "result", "error", "progress"]);
    const status = (map.get("status") as string) ?? "idle";
    const result = map.get("result") as Record<string, unknown> | undefined;
    const error = map.get("error") as string | undefined;
    const progress = map.get("progress") as Record<string, unknown> | undefined;

    return {
      status,
      ...(progress ? { progress } : {}),
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    };
  }

  private async runDiscovery(params: SessionParams): Promise<void> {
    const { sessionId } = params;

    try {
      const anthropicApiKey = await this.env.ANTHROPIC_API_KEY.get();
      if (!anthropicApiKey) {
        await this.fail(sessionId, params.company, "ANTHROPIC_API_KEY not configured");
        return;
      }

      const releasedApiKey = await this.env.RELEASED_API_KEY.get();
      const fetcher = this.env.API_WORKER ?? {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          globalThis.fetch(
            typeof input === "string"
              ? input.replace("https://api", this.env.RELEASED_API_URL.replace(/\/+$/, ""))
              : input,
            init,
          ),
      };

      const executor = createHTTPExecutor({ fetcher, apiKey: releasedApiKey });

      await this.notifyStatusHub({
        type: "session:start",
        sessionId,
        company: params.company,
        sessionType: "onboard",
      }, releasedApiKey);

      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: anthropicApiKey });

      const agent = await (client.beta.agents as any).create({
        name: "Released Discovery Agent",
        model: "claude-sonnet-4-6",
        system: buildSystemPrompt(),
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

      // Build prompt
      const hints: string[] = [];
      if (params.domain) hints.push(`Their website is ${params.domain}.`);
      if (params.githubOrg) hints.push(`Their GitHub organization is ${params.githubOrg}.`);
      const hintStr = hints.length > 0 ? " " + hints.join(" ") : "";
      const prompt = `Find and evaluate changelog sources for "${params.company}".${hintStr} Check what we already have, discover new sources, validate them with dry-run fetches, and write the discovery state file. Do not persist any fetches — dry-run only. For feed sources, note in the state file whether content appears sparse (short summaries) so enrichment can be run after fetching.`;

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

                // Store progress in DO — pollers read it directly (no per-tool StatusHub call)
                await this.ctx.storage.put("progress", {
                  step: "discovery",
                  sourcesFound: 0,
                  sourcesValidated: 0,
                  currentAction: `releases ${command}`,
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

            case "session.error": {
              const errDetail = (event as any).error ?? JSON.stringify(event);
              console.error(`[managed-agents] Session error: ${errDetail}`);
              await this.fail(sessionId, params.company, `Session error: ${errDetail}`, releasedApiKey);
              done = true;
              break;
            }
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
        await this.ctx.storage.put("result", capturedState);
        await this.ctx.storage.put("status", "complete");

        await this.notifyStatusHub({
          type: "session:complete",
          sessionId,
          company: params.company,
          sourcesFound: Array.isArray(capturedState["sources"]) ? (capturedState["sources"] as unknown[]).length : 0,
          result: capturedState,
        }, releasedApiKey);
        return;
      }

      await this.fail(sessionId, params.company, "Agent did not report discovery state", releasedApiKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.fail(sessionId, params.company, message);
    }
  }

  private async fail(sessionId: string, company: string, error: string, cachedApiKey?: string): Promise<void> {
    await this.ctx.storage.put("status", "error");
    await this.ctx.storage.put("error", error);
    await this.notifyStatusHub({
      type: "session:error",
      sessionId,
      company,
      error,
    }, cachedApiKey);
  }

  private async notifyStatusHub(event: Record<string, unknown>, cachedApiKey?: string): Promise<void> {
    try {
      const apiKey = cachedApiKey ?? await this.env.RELEASED_API_KEY.get();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      };
      const body = JSON.stringify(event);

      if (this.env.API_WORKER) {
        await this.env.API_WORKER.fetch(new Request("https://api/v1/status/event", {
          method: "POST", headers, body,
        }));
      } else {
        await fetch(`${this.env.RELEASED_API_URL}/v1/status/event`, {
          method: "POST", headers, body,
        });
      }
    } catch (err) {
      console.error(`[managed-agents] StatusHub notify failed: ${err}`);
    }
  }
}

function buildSystemPrompt(): string {
  return `You manage changelog sources for Released. You find, evaluate, add, fetch, and validate changelog sources using the releases_cli tool.

## CLI Commands Reference

Call the releases_cli tool with the command string (without the "releases" prefix):

- list [slug] [--json] [--org <org>] [--has-feed] [--enrichable] [--product <p>] [--category <c>] [--query <text>]
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

NOTE: The "evaluate" command is not available in this mode. Use "discover" to find sources and "fetch --dry-run" to validate them.

## Available Categories

Valid categories: ${CATEGORIES.join(", ")}

When creating an organization, always include a --description with a brief one-sentence product description.

## Multi-Product Organizations

Some organizations ship multiple distinct products. When you discover sources that clearly belong to different products:
- High confidence (separate repos, separate domains): Create products using product add
- Medium confidence: Note suggested groupings but don't auto-create
- Low confidence: Leave sources at the org level

## Onboarding Workflow

1. **Discover** — use the discover command and web search to find changelog URLs, feeds, and GitHub repos
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
