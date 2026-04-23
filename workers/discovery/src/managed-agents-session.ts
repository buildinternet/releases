/**
 * Durable Object for managed agents discovery sessions.
 *
 * Cloudflare Workers have CPU time limits that a managed agents session
 * exceeds (~60-120s of streaming). Durable Objects reset their 30s
 * wall-clock timer on each I/O operation (API calls, fetches), making
 * them suitable for long-running I/O-bound workloads.
 *
 * Agent and environment are created once via the Anthropic console/API
 * and referenced by ID (env vars). Sessions are the only per-request resource.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types.js";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import {
  classifyMaRateLimitError,
  buildMaRateLimitErrorMessage,
} from "@releases/lib/ma-rate-limit.js";
import { createTypedExecutor, handleCustomToolUse } from "@releases/shared/agent-tools.js";
import { buildDiscoverySystemPrompt } from "@releases/shared/discovery-prompt.js";
import { CATEGORIES } from "@buildinternet/releases-core/categories";
import { scrapeFetch } from "./scrape-fetch.js";
import { discoveryIdentityHeaders } from "./identity.js";

/** Staging access gate header — must match workers/api/src/middleware/staging-access.ts. */
const STAGING_KEY_HEADER = "X-Releases-Staging-Key";

/**
 * Wrap a Fetcher so every outbound request carries the staging access key.
 * Returns the fetcher unchanged when `stagingKey` is empty (prod/local).
 */
function withStagingHeader(fetcher: Fetcher, stagingKey: string): Fetcher {
  if (!stagingKey) return fetcher;
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      req.headers.set(STAGING_KEY_HEADER, stagingKey);
      return fetcher.fetch(req, init);
    },
  } as Fetcher;
}

/**
 * Wrap a Fetcher so every outbound request carries the discovery worker's
 * identity headers (User-Agent, X-Requested-With). These surface in Cloudflare
 * Analytics on the API edge so staging traffic is distinguishable from real
 * visitors. Harmless on service-binding fetches.
 */
function withDiscoveryIdentity(fetcher: Fetcher): Fetcher {
  const identity = discoveryIdentityHeaders();
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      for (const [k, v] of Object.entries(identity)) req.headers.set(k, v);
      return fetcher.fetch(req, init);
    },
  } as Fetcher;
}

// ── MA 429 rate-limit retry loop ─────────────────────────────────────────────
//
// `classifyMaRateLimitError` + `buildMaRateLimitErrorMessage` live in
// `@releases/lib/ma-rate-limit` so their tests resolve `RateLimitError` against
// the same `@anthropic-ai/sdk` install the classifier imports. Because this
// worker is not a Bun workspace, its local `node_modules/@anthropic-ai/sdk`
// would otherwise be a distinct install from the root-hoisted copy, breaking
// `instanceof` in tests.

const MA_RATE_LIMIT_MAX_RETRIES = 2;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…";
}

export interface SessionParams {
  company: string;
  domain?: string;
  githubOrg?: string;
  sessionId: string;
  agentId: string;
  agentVersion?: number;
  environmentId: string;
  mode: "onboard" | "update";
  /** For update mode: source IDs (src_...) or slugs. IDs preferred. */
  sourceIdentifiers?: string[];
  /** Organization ID (org_...) for playbook lookup in update mode. */
  orgId?: string;
  /** Correlation ID from the originating client for end-to-end tracing. */
  correlationId?: string;
}

const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Character cap on the inlined playbook body. ~20K chars ≈ 5K tokens, which
 * keeps the session prompt well under 10% of Haiku's 200K context even when
 * combined with the tool catalog and system prompt. Truncation is surfaced to
 * the agent (not silent) so it can call `manage_playbook(action=get)` for the full content.
 */
const MAX_PLAYBOOK_CHARS = 20_000;

export class ManagedAgentsSession extends DurableObject<Env> {
  /** Cached staging access key — resolved lazily, reused for every outbound api call. */
  private stagingKey: string | null = null;

  private async getStagingKey(): Promise<string> {
    if (this.stagingKey !== null) return this.stagingKey;
    this.stagingKey = (await this.env.STAGING_ACCESS_KEY?.get().catch(() => "")) ?? "";
    return this.stagingKey;
  }

  async startSession(params: SessionParams): Promise<void> {
    await this.ctx.storage.put("params", params);
    await this.ctx.storage.put("status", "running");
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** @deprecated Use startSession instead. Kept for backward compat with existing DO instances. */
  async startDiscovery(params: Omit<SessionParams, "mode">): Promise<void> {
    return this.startSession({ ...params, mode: "onboard" });
  }

  async alarm(): Promise<void> {
    const status = await this.ctx.storage.get<string>("status");
    if (status !== "running") return;

    const params = await this.ctx.storage.get<SessionParams>("params");
    if (!params) return;

    await this.runSession(params);
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

  private async runSession(params: SessionParams): Promise<void> {
    const { sessionId, environmentId, mode } = params;

    // Route update sessions to the worker agent (Haiku) for lower cost
    const workerAgentId = this.env.ANTHROPIC_WORKER_AGENT_ID;
    const useWorker = mode === "update" && workerAgentId;
    const agentId = useWorker ? workerAgentId : params.agentId;
    const agentVersion = useWorker ? undefined : params.agentVersion;

    try {
      // Register the session with StatusHub BEFORE any Anthropic API calls so that
      // the session ID the caller already received is always visible in /v1/sessions.
      // If anything below fails, fail() will update this session row to status=error
      // rather than silently dropping the notification (which happened previously
      // because StatusHub's session:error handler required an existing row).
      const releasesApiKey = await this.env.RELEASED_API_KEY.get();
      await this.notifyStatusHub(
        {
          type: "session:start",
          sessionId,
          company: params.company,
          sessionType: mode,
          agent: useWorker ? "haiku" : "sonnet",
          ...(params.correlationId ? { correlationId: params.correlationId } : {}),
          ...(params.sourceIdentifiers && params.sourceIdentifiers.length > 0
            ? { activeSources: params.sourceIdentifiers }
            : {}),
        },
        releasesApiKey,
      );

      const anthropicApiKey = await this.env.ANTHROPIC_API_KEY.get();
      if (!anthropicApiKey) {
        await this.fail(
          sessionId,
          params.company,
          "ANTHROPIC_API_KEY not configured",
          releasesApiKey,
        );
        return;
      }

      const baseFetcher = this.env.API_WORKER ?? {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          globalThis.fetch(
            typeof input === "string"
              ? input.replace("https://api", this.env.RELEASED_API_URL.replace(/\/+$/, ""))
              : input,
            init,
          ),
      };
      const fetcher = withDiscoveryIdentity(
        withStagingHeader(baseFetcher as Fetcher, await this.getStagingKey()),
      );

      const executor = createTypedExecutor({ fetcher, apiKey: releasesApiKey, sessionId });

      // Resolve Cloudflare secrets for scrape fetch capability
      const [cfAccountId, cfApiToken] = await Promise.all([
        this.env.CLOUDFLARE_ACCOUNT_ID?.get().catch(() => ""),
        this.env.CLOUDFLARE_API_TOKEN?.get().catch(() => ""),
      ]);

      const gatewayToken = await this.env.AI_GATEWAY_TOKEN?.get().catch(() => "");
      const anthropicBaseURL = this.env.ANTHROPIC_BASE_URL;

      const scrapeHandler =
        cfAccountId && cfApiToken
          ? async (sourceIdentifier: string) => {
              return scrapeFetch(
                {
                  cloudflareAccountId: cfAccountId,
                  cloudflareApiToken: cfApiToken,
                  anthropicApiKey: anthropicApiKey,
                  anthropicBaseURL,
                  aiGatewayToken: gatewayToken || undefined,
                  apiFetcher: fetcher,
                  apiKey: releasesApiKey,
                  sessionId,
                },
                sourceIdentifier,
              );
            }
          : undefined;

      const client = buildAnthropicClient({
        apiKey: anthropicApiKey,
        baseURL: anthropicBaseURL,
        gatewayToken: gatewayToken || undefined,
      });

      const sessionTitle =
        mode === "update" ? `Update: ${params.company}` : `Discovery: ${params.company}`;

      const vaultId = this.env.ANTHROPIC_VAULT_ID;
      const sessionCreateParams = {
        agent: { type: "agent", id: agentId, ...(agentVersion ? { version: agentVersion } : {}) },
        environment_id: environmentId,
        ...(vaultId ? { vault_ids: [vaultId] } : {}),
        title: sessionTitle,
      };

      // Retry session creation on 429 rate-limit responses (bounded to MA_RATE_LIMIT_MAX_RETRIES).
      let session: any;
      let rateLimitRetries = 0;
      while (true) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- sequential retry; intentional
          session = await (client.beta.sessions as any).create(sessionCreateParams);
          break;
        } catch (createErr) {
          const classification = classifyMaRateLimitError(createErr);
          if (!classification.isRateLimit) throw createErr;
          if (rateLimitRetries >= MA_RATE_LIMIT_MAX_RETRIES) {
            const structured = buildMaRateLimitErrorMessage(classification, rateLimitRetries);
            console.error(`[managed-agents] ${structured}`);
            // oxlint-disable-next-line no-await-in-loop -- fail() must complete before return
            await this.fail(sessionId, params.company, structured, releasesApiKey);
            return;
          }
          rateLimitRetries++;
          console.error(
            `[managed-agents] 429 rate limit on session create (attempt ${rateLimitRetries}/${MA_RATE_LIMIT_MAX_RETRIES}); retrying in ${Math.round(classification.retryAfterMs / 1000)}s. type=${classification.errorType ?? "unknown"}`,
          );
          // oxlint-disable-next-line no-await-in-loop -- sequential backoff; intentional
          await delay(classification.retryAfterMs);
        }
      }

      // Update StatusHub with the Anthropic session ID now that we have it
      await this.notifyStatusHub(
        {
          type: "session:progress",
          sessionId,
          anthropicSessionId: session.id,
        },
        releasesApiKey,
      );

      let prompt: string;
      if (mode === "update") {
        const idList = (params.sourceIdentifiers ?? []).map((s) => `- ${s}`).join("\n");
        const playbookBlock = await this.loadPlaybookBlock(fetcher, releasesApiKey, params.orgId);
        prompt = `Fetch release updates for "${params.company}".${playbookBlock}\n\nSources to fetch:\n${idList}\n\nCall manage_source(action=fetch) for each source using the source ID as the \`identifier\` parameter (e.g. \`{"action": "fetch", "identifier": "src_abc123"}\`). Report the total releases found and any errors. Do NOT add, remove, or modify sources — only fetch.`;
      } else {
        const systemContext = buildDiscoverySystemPrompt({
          evaluateAvailable: false,
          categories: CATEGORIES,
        });
        const hints: string[] = [];
        if (params.domain) hints.push(`Their website is ${params.domain}.`);
        if (params.githubOrg) hints.push(`Their GitHub organization is ${params.githubOrg}.`);
        const hintStr = hints.length > 0 ? " " + hints.join(" ") : "";
        prompt = `${systemContext}\n\n---\n\nFind and evaluate changelog sources for "${params.company}".${hintStr}`;
      }

      const stream = await (client.beta.sessions.events as any).stream(session.id);
      await (client.beta.sessions.events as any).send(session.id, {
        events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
      });

      // Mutable container so TS tracks closure mutations correctly
      const captured: { state: Record<string, unknown> | null } = { state: null };
      let done = false;
      let toolCallCount = 0;
      let toolErrors = 0;
      let lastAgentMessage = "";
      const deadline = Date.now() + SESSION_TIMEOUT_MS;
      const timeoutId = setTimeout(() => {
        try {
          stream.controller.abort();
        } catch {
          /* closed */
        }
      }, SESSION_TIMEOUT_MS);

      try {
        for await (const event of stream) {
          if (Date.now() > deadline) break;

          switch (event.type) {
            case "agent.custom_tool_use": {
              const toolEvent = event as any;
              const sendResult = async (toolUseId: string, text: string) => {
                if (text.startsWith("Error")) toolErrors++;
                await (client.beta.sessions.events as any).send(session.id, {
                  events: [
                    {
                      type: "user.custom_tool_result",
                      custom_tool_use_id: toolUseId,
                      content: [{ type: "text", text }],
                    },
                  ],
                });
              };
              const wasStateReport = await handleCustomToolUse(
                { id: toolEvent.id, name: toolEvent.name, input: toolEvent.input },
                {
                  sendResult,
                  executor,
                  onScrapeFetch: scrapeHandler,
                  onStateCapture: (state) => {
                    captured.state = state;
                  },
                  onToolCall: (toolName) => {
                    toolCallCount++;
                    this.ctx.storage.put("progress", {
                      step: "discovery",
                      currentAction: toolName,
                    });
                  },
                },
              );
              if (wasStateReport) continue;
              break;
            }

            case "agent.message": {
              for (const block of (event as any).content ?? []) {
                if (block.type === "text" && block.text) {
                  const text = truncate(block.text, 500);
                  lastAgentMessage = block.text;
                  // oxlint-disable-next-line no-await-in-loop -- agent event stream; status hub notifications must be ordered
                  await this.notifyStatusHub(
                    {
                      type: "session:progress",
                      sessionId,
                      logLine: text,
                    },
                    releasesApiKey,
                  );
                }
              }
              break;
            }

            case "agent.tool_use":
            case "agent.mcp_tool_use": {
              const toolName = (event as any).name;
              if (toolName) {
                await this.notifyStatusHub(
                  {
                    type: "session:progress",
                    sessionId,
                    currentAction: toolName,
                  },
                  releasesApiKey,
                );
              }
              break;
            }

            case "agent.tool_result":
            case "agent.mcp_tool_result": {
              for (const block of (event as any).content ?? []) {
                if (block.type === "text" && block.text) {
                  const text = truncate(block.text, 200);
                  // oxlint-disable-next-line no-await-in-loop -- agent event stream; status hub notifications must be ordered
                  await this.notifyStatusHub(
                    {
                      type: "session:progress",
                      sessionId,
                      logLine: text,
                    },
                    releasesApiKey,
                  );
                  break; // only forward first text block
                }
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
              await this.fail(
                sessionId,
                params.company,
                `Session error: ${errDetail}`,
                releasesApiKey,
              );
              done = true;
              break;
            }
          }

          if (done) break;
        }
      } finally {
        clearTimeout(timeoutId);
        try {
          stream.controller.abort();
        } catch {
          /* closed */
        }
      }

      // Retrieve final session for usage tracking (also logged in CLI's managed-discovery.ts)
      let sessionUsage: { inputTokens?: number; outputTokens?: number } | undefined;
      try {
        const finalSession = await (client.beta.sessions as any).retrieve(session.id);
        const usage = finalSession.usage as Record<string, unknown> | undefined;
        if (usage) {
          sessionUsage = {
            inputTokens: usage.input_tokens as number | undefined,
            outputTokens: usage.output_tokens as number | undefined,
          };
          console.log(`[managed-agents] Session usage: ${JSON.stringify(usage)}`);
        }
      } catch {
        // Non-critical
      }

      // Archive session (agent + environment are long-lived, not archived).
      // NOTE: Worker agent (Haiku) sessions show as "terminated" in the Anthropic
      // console while discovery agent sessions do not — possibly a timing/state
      // difference. Both paths call archive identically. Monitor if this causes issues.
      try {
        await (client.beta.sessions as any).archive(session.id);
      } catch {
        /* non-critical */
      }

      if (captured.state) {
        const state = captured.state;
        state["agentSessionId"] = session.id;
        await this.ctx.storage.put("result", state);
        await this.ctx.storage.put("status", "complete");

        await this.notifyStatusHub(
          {
            type: "session:complete",
            sessionId,
            company: params.company,
            sourcesFound: Array.isArray(state["sources"])
              ? (state["sources"] as unknown[]).length
              : 0,
            result: state,
            ...(sessionUsage ? { usage: sessionUsage } : {}),
          },
          releasesApiKey,
        );
        return;
      }

      // Update sessions don't require a state report — but must have done useful work
      if (mode === "update") {
        if (toolCallCount === 0 || (toolErrors > 0 && toolErrors >= toolCallCount)) {
          const reason =
            toolCallCount === 0
              ? "Agent completed without calling any tools"
              : `All ${toolErrors} tool call(s) failed`;
          const detail = lastAgentMessage
            ? `${reason}: ${truncate(lastAgentMessage, 120)}`
            : reason;
          await this.fail(sessionId, params.company, detail, releasesApiKey, sessionUsage);
          return;
        }
        await this.ctx.storage.put("status", "complete");
        await this.notifyStatusHub(
          {
            type: "session:complete",
            sessionId,
            company: params.company,
            ...(sessionUsage ? { usage: sessionUsage } : {}),
          },
          releasesApiKey,
        );
        return;
      }

      await this.fail(
        sessionId,
        params.company,
        "Agent did not report discovery state",
        releasesApiKey,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.fail(sessionId, params.company, message);
    }
  }

  private async fail(
    sessionId: string,
    company: string,
    error: string,
    cachedApiKey?: string,
    usage?: { inputTokens?: number; outputTokens?: number },
  ): Promise<void> {
    await this.ctx.storage.put("status", "error");
    await this.ctx.storage.put("error", error);
    await this.notifyStatusHub(
      {
        type: "session:error",
        sessionId,
        company,
        error,
        ...(usage ? { usage } : {}),
      },
      cachedApiKey,
    );
  }

  /**
   * Fetch the org's playbook from the API worker and format it as a prompt
   * block. Returns "" when no orgId is supplied, the playbook doesn't exist,
   * or the fetch fails — the session continues without it in those cases.
   *
   * Inlining the playbook removes the need for the worker agent to call
   * `manage_playbook(action=get)` as its first step, eliminating a class of
   * tool-name hallucinations (e.g. `get_source_guide`) observed in production.
   */
  private async loadPlaybookBlock(
    fetcher: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> },
    apiKey: string,
    orgId: string | undefined,
  ): Promise<string> {
    if (!orgId) return "";
    try {
      const res = await fetcher.fetch(`https://api/v1/playbook?slug=${encodeURIComponent(orgId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return "";
      const page = (await res.json()) as { content?: string | null; notes?: string | null } | null;
      const header = page?.content?.trim() ?? "";
      const notes = page?.notes?.trim() ?? "";
      const parts = [header, notes ? `## Agent Notes\n\n${notes}` : ""].filter(Boolean);
      if (parts.length === 0) return "";
      const body = parts.join("\n\n");
      const displayBody =
        body.length > MAX_PLAYBOOK_CHARS
          ? `${body.slice(0, MAX_PLAYBOOK_CHARS)}\n\n_[Playbook truncated from ${body.length} to ${MAX_PLAYBOOK_CHARS} characters. Call \`manage_playbook(action=get)\` for the full content if a trap or instruction looks cut off.]_`
          : body;
      return `\n\n---\n\n## Playbook for this org\n\n${displayBody}\n\n---`;
    } catch (err) {
      console.error(`[managed-agents] playbook fetch failed: ${err}`);
      return "";
    }
  }

  private async notifyStatusHub(
    event: Record<string, unknown>,
    cachedApiKey?: string,
  ): Promise<void> {
    try {
      const apiKey = cachedApiKey ?? (await this.env.RELEASED_API_KEY.get());
      const stagingKey = await this.getStagingKey();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...discoveryIdentityHeaders(),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(stagingKey ? { [STAGING_KEY_HEADER]: stagingKey } : {}),
      };
      const body = JSON.stringify(event);

      if (this.env.API_WORKER) {
        await this.env.API_WORKER.fetch(
          new Request("https://api/v1/status/event", {
            method: "POST",
            headers,
            body,
          }),
        );
      } else {
        await fetch(`${this.env.RELEASED_API_URL}/v1/status/event`, {
          method: "POST",
          headers,
          body,
        });
      }
    } catch (err) {
      console.error(`[managed-agents] StatusHub notify failed: ${err}`);
    }
  }
}
