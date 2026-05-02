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
import { estimateCost } from "@releases/lib/anthropic-pricing.js";
import {
  classifyMaRateLimitError,
  buildMaRateLimitErrorMessage,
} from "@releases/lib/ma-rate-limit.js";
import { escapeForPromptTag } from "@releases/lib/prompt-escape.js";
import { createTypedExecutor, handleCustomToolUse } from "@releases/shared/agent-tools.js";
import { buildDiscoverySystemPrompt } from "@releases/shared/discovery-prompt.js";
import { buildMemoryStoreResources } from "@releases/shared/memory-store-attach.js";
import { CATEGORIES } from "@buildinternet/releases-core/categories";
import { scrapeFetch } from "./scrape-fetch.js";
import { discoveryIdentityHeaders } from "./identity.js";
import {
  STAGING_KEY_HEADER,
  withStagingHeader,
  withDiscoveryIdentity,
  directApiFetcher,
} from "./fetch-wrappers.js";

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

import {
  classifyProviderSessionError,
  isRetriesExhaustedIdle,
  type SessionErrorClassification,
} from "./session-error-classify.js";

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

    // Captured once the Anthropic session is created. Archived in `finally`
    // below so timeout-abort and unexpected-throw paths leave the session in a
    // clean state — without it, the un-answered tool event from a stalled
    // fetch locks subsequent retries with a 400. See #632.
    let pendingArchive: { client: ReturnType<typeof buildAnthropicClient>; id: string } | null =
      null;

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

      // Direct fetch used when no service binding is present (local dev /
      // tests). Rewrites the placeholder `https://api/...` host to
      // `RELEASED_API_URL`, handling string, URL, and Request inputs — by the
      // time this fetcher is invoked, the wrappers above have already upgraded
      // strings into Request objects.
      const baseFetcher = this.env.API_WORKER ?? directApiFetcher(this.env.RELEASED_API_URL);
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
                  extractToolLoopEnabled: this.env.EXTRACT_TOOLLOOP_ENABLED,
                },
                sourceIdentifier,
              );
            }
          : undefined;

      // The managed-agents session client uses `events.stream(...)` — a
      // long-lived `GET /v1/sessions/<id>/events/stream` returning
      // `text/event-stream`. Cloudflare AI Gateway buffers SSE responses on
      // GET requests until the upstream connection closes (see #547), which
      // means the SDK's `for await of stream` loop never receives any events,
      // the agent never gets the initial `user.message`, and the session
      // sits at `usage.input_tokens: 0` indefinitely. Skip the gateway here
      // and hit api.anthropic.com directly. Other call sites (admin-ai,
      // extract-deps) keep using the gateway because they're non-streaming
      // POSTs that survive the proxy fine.
      //
      // We pass `baseURL` explicitly because the SDK auto-reads
      // `ANTHROPIC_BASE_URL` from env (set in wrangler.jsonc to the gateway
      // URL); leaving baseURL undefined would let that env value win.
      const client = buildAnthropicClient({
        apiKey: anthropicApiKey,
        baseURL: "https://api.anthropic.com",
      });

      const sessionTitle =
        mode === "update" ? `Update: ${params.company}` : `Discovery: ${params.company}`;

      const vaultId = this.env.ANTHROPIC_VAULT_ID;
      const memoryResources = buildMemoryStoreResources({
        mode,
        orgId: params.orgId,
        errataStoreId: this.env.MEMORY_STORE_ERRATA_ID,
        toolNotesStoreId: this.env.MEMORY_STORE_TOOL_NOTES_ID,
      });
      const sessionCreateParams = {
        agent: { type: "agent", id: agentId, ...(agentVersion ? { version: agentVersion } : {}) },
        environment_id: environmentId,
        ...(vaultId ? { vault_ids: [vaultId] } : {}),
        ...(memoryResources.length > 0 ? { resources: memoryResources } : {}),
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
            await this.fail(sessionId, params.company, structured, releasesApiKey, undefined, {
              errorSource: "provider",
              errorType: classification.errorType ?? "rate_limit",
              retryCount: rateLimitRetries,
              message: structured,
            });
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

      pendingArchive = { client, id: session.id };

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
        const idList = (params.sourceIdentifiers ?? [])
          .map((s) => `- ${escapeForPromptTag(s)}`)
          .join("\n");
        const playbookBlock = await this.loadPlaybookBlock(fetcher, releasesApiKey, params.orgId);
        prompt = `<task>
Fetch release updates for the company described in <company>.
Sources to fetch are listed in <sources>.
Call manage_source(action=fetch) for each source using the source ID as the \`identifier\` parameter (e.g. \`{"action": "fetch", "identifier": "src_abc123"}\`). Report the total releases found and any errors. Do NOT add, remove, or modify sources — only fetch.
</task>

<company>${escapeForPromptTag(params.company)}</company>
<sources>
${idList}
</sources>${playbookBlock}`;
      } else {
        const systemContext = buildDiscoverySystemPrompt({
          evaluateAvailable: false,
          categories: CATEGORIES,
        });
        const domainBlock = params.domain
          ? `\n<domain>${escapeForPromptTag(params.domain)}</domain>`
          : "";
        const githubOrgBlock = params.githubOrg
          ? `\n<github_org>${escapeForPromptTag(params.githubOrg)}</github_org>`
          : "";
        prompt = `${systemContext}\n\n---\n\n<task>
Find and evaluate changelog sources for the company described in <company>.${domainBlock ? " Their website domain is in <domain>." : ""}${githubOrgBlock ? " Their GitHub organization is in <github_org>." : ""}
</task>

<company>${escapeForPromptTag(params.company)}</company>${domainBlock}${githubOrgBlock}`;
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
      // Track provider session.error events so a subsequent retries_exhausted
      // status_idle can attribute the failure to the upstream incident rather
      // than falling through to our-side "no tools called" detection.
      let providerErrorCount = 0;
      let lastProviderError: SessionErrorClassification | null = null;
      // Set when the loop already emitted a terminal session:error event.
      // Suppresses the post-loop fallback that would otherwise double-fire a
      // less-specific "no tools called" failure on top of the classified one.
      let terminalFailed = false;
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
                  getRemainingSessionMs: () => Math.max(0, deadline - Date.now()),
                  sessionId: session.id,
                  agentName: useWorker ? "worker" : "discovery",
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
              if (isRetriesExhaustedIdle(event)) {
                // Attribute to the last provider error we saw so the failure
                // shows "managed-agents · <type>" instead of falling through
                // to our-side "no tools called" detection below.
                const classification: SessionErrorClassification = lastProviderError
                  ? {
                      ...lastProviderError,
                      stopReason: "retries_exhausted",
                      retryCount: providerErrorCount,
                    }
                  : {
                      errorSource: "provider",
                      stopReason: "retries_exhausted",
                      retryCount: providerErrorCount,
                      message: "Managed-agents retry budget exhausted",
                    };
                console.error(
                  `[managed-agents] retries_exhausted after ${providerErrorCount} provider error(s)`,
                );
                await this.fail(
                  sessionId,
                  params.company,
                  classification.message,
                  releasesApiKey,
                  undefined,
                  classification,
                );
                terminalFailed = true;
              }
              done = true;
              break;

            case "session.status_terminated":
              done = true;
              break;

            case "session.error": {
              providerErrorCount++;
              const classification = classifyProviderSessionError(event) ?? {
                errorSource: "provider" as const,
                message: `Session error: ${JSON.stringify(event)}`,
              };
              lastProviderError = classification;
              console.error(
                `[managed-agents] Session error (${classification.errorType ?? "unknown"}): ${classification.message}`,
              );
              await this.fail(
                sessionId,
                params.company,
                classification.message,
                releasesApiKey,
                undefined,
                { ...classification, retryCount: providerErrorCount - 1 },
              );
              terminalFailed = true;
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

      // Skip the post-loop fallback failures when the loop already emitted a
      // classified session:error — otherwise the fallback overwrites it.
      // Session archive runs in the outer finally regardless.
      if (terminalFailed) {
        return;
      }

      // Retrieve final session for usage tracking (also logged in CLI's
      // managed-discovery.ts). The pricing helper uses cache-aware token
      // counts to produce a list-price USD estimate that StatusHub stores
      // and the /status page renders. The estimate is computed once here
      // and snapshotted — not recalculated on read — so price changes
      // don't rewrite history.
      const inferredModel = useWorker ? "claude-haiku-4-5" : "claude-sonnet-4-6";
      let sessionUsage:
        | {
            inputTokens?: number;
            outputTokens?: number;
            cacheWriteTokens?: number;
            cacheReadTokens?: number;
            model?: string;
            estimatedUsd?: number;
          }
        | undefined;
      try {
        const finalSession = await (client.beta.sessions as any).retrieve(session.id);
        const usage = finalSession.usage as Record<string, unknown> | undefined;
        if (usage) {
          const inputTokens = usage.input_tokens as number | undefined;
          const outputTokens = usage.output_tokens as number | undefined;
          const cacheWriteTokens = usage.cache_creation_input_tokens as number | undefined;
          const cacheReadTokens = usage.cache_read_input_tokens as number | undefined;
          const model = (finalSession.model as string | undefined) ?? inferredModel;
          const cost = estimateCost(
            { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens },
            model,
          );
          sessionUsage = {
            inputTokens,
            outputTokens,
            cacheWriteTokens,
            cacheReadTokens,
            model,
            ...(cost ? { estimatedUsd: cost.totalUsd } : {}),
          };
          console.log(
            `[managed-agents] Session usage: ${JSON.stringify(usage)} model=${model} estimatedUsd=${cost?.totalUsd?.toFixed(4) ?? "?"}`,
          );
        }
      } catch {
        // Non-critical
      }

      // Archive runs in the outer `finally` for every exit path — see the
      // comment on `pendingArchive` at the top of runSession. NOTE: worker
      // (Haiku) sessions show as "terminated" in the Anthropic console while
      // discovery sessions do not — possibly a timing/state difference; both
      // paths archive identically.

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
    } finally {
      if (pendingArchive) {
        try {
          await (pendingArchive.client.beta.sessions as any).archive(pendingArchive.id);
        } catch {
          /* non-critical */
        }
      }
    }
  }

  private async fail(
    sessionId: string,
    company: string,
    error: string,
    cachedApiKey?: string,
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheWriteTokens?: number;
      cacheReadTokens?: number;
      model?: string;
      estimatedUsd?: number;
    },
    classification?: SessionErrorClassification,
  ): Promise<void> {
    await this.ctx.storage.put("status", "error");
    await this.ctx.storage.put("error", error);
    // Default unclassified failures to errorSource: "us" — keeps the wire
    // contract on every error event without requiring every call site to opt
    // in. Provider-side paths pass `classification` explicitly.
    const errorSource = classification?.errorSource ?? "us";
    await this.notifyStatusHub(
      {
        type: "session:error",
        sessionId,
        company,
        error,
        errorSource,
        ...(classification?.errorType ? { errorType: classification.errorType } : {}),
        ...(classification?.stopReason ? { stopReason: classification.stopReason } : {}),
        ...(classification?.retryCount !== undefined
          ? { retryCount: classification.retryCount }
          : {}),
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
      const res = await fetcher.fetch(`https://api/v1/orgs/${encodeURIComponent(orgId)}/playbook`, {
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
