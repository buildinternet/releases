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
import { logEvent } from "@releases/lib/log-event.js";

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

  /**
   * Pull the final usage envelope from the Anthropic API and snapshot a
   * list-price USD estimate. Called from both the success exit (after the
   * stream loop) and the terminal-error branches (provider session.error,
   * retries_exhausted_idle) so failed sessions get cost attribution too —
   * otherwise the /status page would show $? on every error.
   *
   * Returns `undefined` if the API call fails or the session has no usage
   * yet — this is best-effort and never blocks the failure path.
   */
  private async captureFinalUsage(
    client: ReturnType<typeof buildAnthropicClient>,
    anthropicSessionId: string,
    agentRole: "discovery" | "worker" | "coordinator",
  ): Promise<
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheWriteTokens?: number;
        cacheReadTokens?: number;
        model?: string;
        estimatedUsd?: number;
        /**
         * Per-thread breakdown for multi-agent sessions. Empty / absent for
         * single-agent paths (discovery, worker). Populated when threads.list
         * returns more than one thread (i.e. coordinator delegated at least
         * once). Used by the /status cost card to show the Sonnet/Haiku split.
         */
        byThread?: {
          threadId?: string;
          agentName?: string;
          model: string;
          inputTokens?: number;
          outputTokens?: number;
          cacheWriteTokens?: number;
          cacheReadTokens?: number;
          estimatedUsd?: number;
        }[];
      }
    | undefined
  > {
    // Inferred model is a fallback when sessions.retrieve doesn't surface the
    // model on the response. Coordinator and discovery both run Sonnet today.
    const inferredModel = agentRole === "worker" ? "claude-haiku-4-5" : "claude-sonnet-4-6";
    try {
      const finalSession = await (client.beta.sessions as any).retrieve(anthropicSessionId);
      const usage = finalSession.usage as Record<string, unknown> | undefined;
      const inputTokens = usage?.input_tokens as number | undefined;
      const outputTokens = usage?.output_tokens as number | undefined;
      const cacheWriteTokens = usage?.cache_creation_input_tokens as number | undefined;
      const cacheReadTokens = usage?.cache_read_input_tokens as number | undefined;
      const model = (finalSession.model as string | undefined) ?? inferredModel;

      // Per-thread breakdown (multi-agent only). The session-level `usage` may
      // already aggregate across threads — this is intentionally additive,
      // surfacing the Sonnet/Haiku split for cost attribution rather than
      // replacing the aggregate. Best-effort: any failure on threads.list
      // collapses back to the single-agent path.
      type ThreadUsageRow = {
        threadId?: string;
        agentName?: string;
        model: string;
        inputTokens?: number;
        outputTokens?: number;
        cacheWriteTokens?: number;
        cacheReadTokens?: number;
        estimatedUsd?: number;
      };
      let byThread: ThreadUsageRow[] | undefined = undefined;
      if (agentRole === "coordinator") {
        try {
          // `(client.beta.sessions as any)` matches the call-site cast we use
          // elsewhere in this file: the worker's separate SDK install means
          // some IDE TS servers don't pick up the typed `threads` namespace
          // even though `tsc` does. The downstream `t` is annotated to keep
          // the typed property access (`t.usage?.input_tokens`, etc.).
          const threadList = await (client.beta.sessions as any).threads.list(anthropicSessionId);
          const threads = (threadList.data ?? []) as Array<{
            id?: string;
            agent?: { name?: string; model?: { id?: string } };
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_creation?: {
                ephemeral_1h_input_tokens?: number;
                ephemeral_5m_input_tokens?: number;
              };
              cache_read_input_tokens?: number;
            };
          }>;
          if (threads.length > 0) {
            byThread = threads.map((t) => {
              const tInput = t.usage?.input_tokens;
              const tOutput = t.usage?.output_tokens;
              // Cache creation is split by lifetime in the typed shape; sum
              // both buckets for the single estimateCost slot.
              const cc = t.usage?.cache_creation;
              const tCacheW =
                cc !== undefined
                  ? (cc.ephemeral_1h_input_tokens ?? 0) + (cc.ephemeral_5m_input_tokens ?? 0)
                  : undefined;
              const tCacheR = t.usage?.cache_read_input_tokens;
              const tModel = t.agent?.model?.id ?? inferredModel;
              const tCost = estimateCost(
                {
                  inputTokens: tInput,
                  outputTokens: tOutput,
                  cacheWriteTokens: tCacheW,
                  cacheReadTokens: tCacheR,
                },
                tModel,
              );
              // Direct assignment (rather than spread-undefined) keeps
              // allocations off the hot path — oxlint no-loop-allocation flags
              // the spread form here. JSON.stringify drops undefined fields on
              // the wire, so the resulting shape matches the session-level
              // return below.
              const row: ThreadUsageRow = { model: tModel };
              if (typeof t.id === "string") row.threadId = t.id;
              if (typeof t.agent?.name === "string") row.agentName = t.agent.name;
              if (tInput !== undefined) row.inputTokens = tInput;
              if (tOutput !== undefined) row.outputTokens = tOutput;
              if (tCacheW !== undefined) row.cacheWriteTokens = tCacheW;
              if (tCacheR !== undefined) row.cacheReadTokens = tCacheR;
              if (tCost) row.estimatedUsd = tCost.totalUsd;
              return row;
            });
          }
        } catch (err) {
          logEvent("warn", {
            component: "managed-agents",
            event: "thread-usage-list-failed",
            err: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }

      // If session-level usage is empty but threads have it, aggregate.
      // Single pass — sums all four token buckets at once instead of four scans.
      const threadTotals = byThread?.reduce(
        (s, t) => ({
          input: s.input + (t.inputTokens ?? 0),
          output: s.output + (t.outputTokens ?? 0),
          cacheW: s.cacheW + (t.cacheWriteTokens ?? 0),
          cacheR: s.cacheR + (t.cacheReadTokens ?? 0),
        }),
        { input: 0, output: 0, cacheW: 0, cacheR: 0 },
      );
      const aggInput = inputTokens ?? threadTotals?.input;
      const aggOutput = outputTokens ?? threadTotals?.output;
      const aggCacheW = cacheWriteTokens ?? threadTotals?.cacheW;
      const aggCacheR = cacheReadTokens ?? threadTotals?.cacheR;

      if (aggInput === undefined && aggOutput === undefined && !byThread?.length) return undefined;

      const cost = estimateCost(
        {
          inputTokens: aggInput,
          outputTokens: aggOutput,
          cacheWriteTokens: aggCacheW,
          cacheReadTokens: aggCacheR,
        },
        model,
      );
      logEvent("info", {
        component: "managed-agents",
        event: "session-usage",
        usage,
        model,
        estimatedUsd: cost?.totalUsd ?? null,
        threadCount: byThread?.length ?? null,
      });
      return {
        ...(aggInput !== undefined ? { inputTokens: aggInput } : {}),
        ...(aggOutput !== undefined ? { outputTokens: aggOutput } : {}),
        ...(aggCacheW !== undefined ? { cacheWriteTokens: aggCacheW } : {}),
        ...(aggCacheR !== undefined ? { cacheReadTokens: aggCacheR } : {}),
        model,
        ...(cost ? { estimatedUsd: cost.totalUsd } : {}),
        ...(byThread && byThread.length > 0 ? { byThread } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private async runSession(params: SessionParams): Promise<void> {
    const { sessionId, environmentId, mode } = params;

    // Agent selection:
    //   - update + ANTHROPIC_WORKER_AGENT_ID → single-agent Haiku (legacy)
    //   - onboard + ANTHROPIC_COORDINATOR_AGENT_ID → multi-agent coordinator
    //     (Sonnet) that delegates fetches to the worker via the
    //     agent_toolset_20260401 tool. Subordinate-thread custom-tool calls
    //     are cross-posted to the primary stream with session_thread_id;
    //     handleCustomToolUse + sendResult work unchanged because the server
    //     routes the reply by custom_tool_use_id.
    //   - otherwise → single-agent discovery (Sonnet, current default).
    const workerAgentId = this.env.ANTHROPIC_WORKER_AGENT_ID;
    const coordinatorAgentId = this.env.ANTHROPIC_COORDINATOR_AGENT_ID;
    let agentRole: "discovery" | "worker" | "coordinator";
    let agentId: string;
    let agentVersion: number | undefined;
    if (mode === "update" && workerAgentId) {
      agentRole = "worker";
      agentId = workerAgentId;
      agentVersion = undefined;
    } else if (mode === "onboard" && coordinatorAgentId) {
      agentRole = "coordinator";
      agentId = coordinatorAgentId;
      agentVersion = undefined;
    } else {
      agentRole = "discovery";
      agentId = params.agentId;
      agentVersion = params.agentVersion;
    }

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
      let statusHubAgentLabel: "haiku" | "sonnet" | "coordinator";
      switch (agentRole) {
        case "worker":
          statusHubAgentLabel = "haiku";
          break;
        case "coordinator":
          statusHubAgentLabel = "coordinator";
          break;
        default:
          statusHubAgentLabel = "sonnet";
      }
      await this.notifyStatusHub(
        {
          type: "session:start",
          sessionId,
          company: params.company,
          sessionType: mode,
          agent: statusHubAgentLabel,
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
            logEvent("error", {
              component: "managed-agents",
              event: "rate-limit-retries-exhausted",
              retryCount: rateLimitRetries,
              errorType: classification.errorType ?? "rate_limit",
              message: structured,
            });
            // oxlint-disable-next-line no-await-in-loop -- fail() must complete before return
            await this.fail(sessionId, params.company, structured, releasesApiKey, undefined, {
              errorSource: "provider",
              errorType: classification.errorType ?? "rate_limit",
              retryCount: rateLimitRetries,
              message: structured,
              severity: "fatal",
            });
            return;
          }
          rateLimitRetries++;
          logEvent("error", {
            component: "managed-agents",
            event: "session-create-rate-limited",
            attempt: rateLimitRetries,
            maxRetries: MA_RATE_LIMIT_MAX_RETRIES,
            retryAfterSecs: Math.round(classification.retryAfterMs / 1000),
            errorType: classification.errorType ?? "unknown",
          });
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
        // Coordinator agents already carry their full system prompt on the
        // agent definition, so the onboard task message is just the
        // <task>/<company>/... block. Single-agent discovery (legacy path)
        // continues to inline the discovery system prompt because that's how
        // the agent was configured before the prompt-on-definition cleanup.
        const domainBlock = params.domain
          ? `\n<domain>${escapeForPromptTag(params.domain)}</domain>`
          : "";
        const githubOrgBlock = params.githubOrg
          ? `\n<github_org>${escapeForPromptTag(params.githubOrg)}</github_org>`
          : "";
        const taskBlock = `<task>
Find and evaluate changelog sources for the company described in <company>.${domainBlock ? " Their website domain is in <domain>." : ""}${githubOrgBlock ? " Their GitHub organization is in <github_org>." : ""}
</task>

<company>${escapeForPromptTag(params.company)}</company>${domainBlock}${githubOrgBlock}`;
        if (agentRole === "coordinator") {
          prompt = taskBlock;
        } else {
          const systemContext = buildDiscoverySystemPrompt({
            evaluateAvailable: false,
            categories: CATEGORIES,
          });
          prompt = `${systemContext}\n\n---\n\n${taskBlock}`;
        }
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

      // ── Pending custom-tool results, batched per turn ──────────────────
      // The model may emit multiple custom_tool_use events in one turn
      // (parallel tool calls). The conversation moves on the moment any one
      // result lands, so the second `events.send` would hit "no non-archived
      // thread is waiting on tool_use_id". We collect each tool's result via
      // a deferred promise here and flush them as a single events.send batch
      // when the matching `*_status_idle` event fires with
      // `stop_reason: { type: "requires_action", event_ids: [...] }`. State-
      // report tools resolve to `null` and contribute nothing to the flush.
      type PendingResult = { toolUseId: string; text: string; isError: boolean } | null;
      type PendingTool = {
        threadIdForRouting: string | null;
        resultPromise: Promise<PendingResult>;
      };
      const pendingByToolUseId = new Map<string, PendingTool>();
      const flushRequiredAction = async (
        eventIds: string[],
        threadIdForRouting: string | null,
      ): Promise<void> => {
        const flushable = eventIds.flatMap((id) => {
          const entry = pendingByToolUseId.get(id);
          return entry ? [{ id, entry }] : [];
        });
        if (flushable.length === 0) return;
        // Drop entries up front — the model isn't waiting on a state-report-only
        // tool's result, and an awaited handler can't re-resolve.
        for (const { id } of flushable) pendingByToolUseId.delete(id);
        // oxlint-disable-next-line no-await-in-loop -- handlers run concurrently; this awaits the joined set
        const resolved = await Promise.all(flushable.map((x) => x.entry.resultPromise));
        const events: Record<string, unknown>[] = [];
        resolved.forEach((r, i) => {
          if (r === null) return;
          if (r.isError) toolErrors++;
          const routing = flushable[i].entry.threadIdForRouting ?? threadIdForRouting;
          events.push({
            type: "user.custom_tool_result",
            custom_tool_use_id: r.toolUseId,
            content: [{ type: "text", text: r.text }],
            ...(routing ? { session_thread_id: routing } : {}),
          });
        });
        if (events.length === 0) return;
        await (client.beta.sessions.events as any).send(session.id, { events });
      };
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
              const toolUseId = toolEvent.id as string;
              // Multi-agent: when the call originated on a subordinate thread,
              // the event is cross-posted to the primary stream with
              // `session_thread_id` set. Echo it on the result so the server
              // routes the reply back to the waiting thread.
              const threadIdForRouting =
                (toolEvent.session_thread_id as string | null | undefined) ?? null;
              // Defer: enqueue a promise that resolves when the handler calls
              // sendResult (or to null on state-report tools). The flush
              // happens on the next *_status_idle with requires_action so all
              // parallel results go in one batch.
              let resolveFn!: (v: PendingResult) => void;
              const resultPromise = new Promise<PendingResult>((r) => {
                resolveFn = r;
              });
              pendingByToolUseId.set(toolUseId, { threadIdForRouting, resultPromise });
              void (async () => {
                try {
                  const wasStateReport = await handleCustomToolUse(
                    { id: toolUseId, name: toolEvent.name, input: toolEvent.input },
                    {
                      sendResult: async (id: string, text: string) => {
                        resolveFn({ toolUseId: id, text, isError: text.startsWith("Error") });
                      },
                      executor,
                      onScrapeFetch: scrapeHandler,
                      getRemainingSessionMs: () => Math.max(0, deadline - Date.now()),
                      sessionId: session.id,
                      agentName: agentRole,
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
                  if (wasStateReport) {
                    // No tool result to send back; flush will skip this one.
                    resolveFn(null);
                  }
                } catch (err) {
                  // Surface handler crashes as error tool results so the
                  // model gets feedback rather than waiting forever.
                  resolveFn({
                    toolUseId,
                    text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                    isError: true,
                  });
                }
              })();
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

            // ── Multi-agent (coordinator) thread events ─────────────────
            // Subordinate-thread lifecycle is mirrored to the primary stream
            // for visibility. None of these are session-terminal — the
            // session is terminal when the coordinator's `session.status_idle`
            // fires below. We forward as status-hub log lines and do not set
            // `done`. Custom-tool calls from subordinate threads still come
            // through as `agent.custom_tool_use` (handled above) with
            // `session_thread_id` set; the server routes our reply by
            // `custom_tool_use_id` so dispatch is unchanged.
            case "session.thread_created": {
              const threadId = (event as any).session_thread_id;
              const agentName = (event as any).agent_name ?? "subordinate";
              await this.notifyStatusHub(
                {
                  type: "session:progress",
                  sessionId,
                  logLine: `[${agentName}] thread ${threadId} created`,
                },
                releasesApiKey,
              );
              break;
            }

            case "session.thread_status_running":
            case "session.thread_status_idle":
            case "session.thread_status_terminated": {
              const threadId = (event as any).session_thread_id;
              const stopReason = (event as any).stop_reason;
              const stop = stopReason?.type;
              const status = (event.type as string).replace("session.thread_status_", "");
              const suffix = stop ? ` (${stop})` : "";
              await this.notifyStatusHub(
                {
                  type: "session:progress",
                  sessionId,
                  logLine: `[thread ${threadId}] ${status}${suffix}`,
                },
                releasesApiKey,
              );
              if (
                event.type === "session.thread_status_idle" &&
                stop === "requires_action" &&
                Array.isArray(stopReason?.event_ids)
              ) {
                await flushRequiredAction(stopReason.event_ids, threadId ?? null);
              }
              break;
            }

            case "agent.thread_message_received":
            case "agent.thread_message_sent": {
              // Each direction populates only one of the two name fields, so a
              // fallback covers both cases without branching.
              const e = event as {
                from_agent_name?: string;
                to_agent_name?: string;
                content?: { type?: string; text?: string }[];
              };
              const peerName = e.from_agent_name ?? e.to_agent_name ?? "unknown";
              const direction = event.type === "agent.thread_message_received" ? "←" : "→";
              const firstText =
                Array.isArray(e.content) && e.content[0]?.type === "text" ? e.content[0].text : "";
              const text = firstText ? truncate(firstText, 240) : "";
              await this.notifyStatusHub(
                {
                  type: "session:progress",
                  sessionId,
                  logLine: `${direction} ${peerName}${text ? `: ${text}` : ""}`,
                },
                releasesApiKey,
              );
              break;
            }

            case "session.status_idle":
              if ((event as any).stop_reason?.type === "requires_action") {
                // Belt-and-suspenders: thread_status_idle handles routed
                // flushes already. This catches sessions where no per-thread
                // event fires (older single-agent sessions) by flushing on
                // the primary thread. The map is per-toolUseId so the
                // thread-level flush already cleared its entries.
                const eventIds = (event as any).stop_reason?.event_ids ?? [];
                if (Array.isArray(eventIds) && eventIds.length > 0) {
                  await flushRequiredAction(eventIds, null);
                }
                continue;
              }
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
                      severity: "fatal",
                    };
                logEvent("error", {
                  component: "managed-agents",
                  event: "retries-exhausted",
                  providerErrorCount,
                });
                const usageOnError = await this.captureFinalUsage(client, session.id, agentRole);
                await this.fail(
                  sessionId,
                  params.company,
                  classification.message,
                  releasesApiKey,
                  usageOnError,
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
              const classification: SessionErrorClassification = classifyProviderSessionError(
                event,
              ) ?? {
                errorSource: "provider",
                message: `Session error: ${JSON.stringify(event)}`,
                severity: "fatal",
              };
              lastProviderError = classification;
              logEvent(classification.severity === "fatal" ? "error" : "warn", {
                component: "managed-agents",
                event: "session-error",
                errorType: classification.errorType ?? "unknown",
                severity: classification.severity,
                message: classification.message,
                providerErrorCount,
              });
              if (classification.severity === "soft") {
                // Sub-task gave up (skill setup, MCP fetch). The conversation
                // is still alive — surface as a status-hub log and keep
                // streaming. If the session genuinely can't recover, a later
                // session.status_terminated or retries_exhausted idle will
                // finish it via the existing branches.
                // oxlint-disable-next-line no-await-in-loop -- ordered status updates
                await this.notifyStatusHub(
                  {
                    type: "session:progress",
                    sessionId,
                    logLine: `[managed-agents] non-fatal: ${classification.message}`,
                  },
                  releasesApiKey,
                );
                break;
              }
              const usageOnError = await this.captureFinalUsage(client, session.id, agentRole);
              await this.fail(
                sessionId,
                params.company,
                classification.message,
                releasesApiKey,
                usageOnError,
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

      // Snapshot final usage + cost via the shared helper; same call site as
      // the terminal-error branches so success and failure both attribute
      // cost correctly. See `captureFinalUsage` below.
      const sessionUsage = await this.captureFinalUsage(client, session.id, agentRole);

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
      logEvent("error", {
        component: "managed-agents",
        event: "playbook-fetch-failed",
        orgId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
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
      logEvent("error", {
        component: "managed-agents",
        event: "status-hub-notify-failed",
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
}
