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
import { createTypedExecutor, handleCustomToolUse } from "@releases/shared/agent-tools.js";
import { buildDiscoverySystemPrompt } from "@releases/shared/discovery-prompt.js";
import { CATEGORIES } from "@releases/lib/categories.js";

export interface SessionParams {
  company: string;
  domain?: string;
  githubOrg?: string;
  sessionId: string;
  agentId: string;
  agentVersion?: number;
  environmentId: string;
  mode: "onboard" | "update";
  /** For update mode: source slugs to fetch. */
  sourceSlugs?: string[];
}

const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

export class ManagedAgentsSession extends DurableObject<Env> {

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
    const { sessionId, agentId, agentVersion, environmentId, mode } = params;
    const sessionType = mode === "update" ? "update" : "onboard";

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

      const executor = createTypedExecutor({ fetcher, apiKey: releasedApiKey });

      await this.notifyStatusHub({
        type: "session:start",
        sessionId,
        company: params.company,
        sessionType,
      }, releasedApiKey);

      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: anthropicApiKey });

      const sessionTitle = mode === "update"
        ? `Update: ${params.company}`
        : `Discovery: ${params.company}`;

      const vaultId = this.env.ANTHROPIC_VAULT_ID;
      const session = await (client.beta.sessions as any).create({
        agent: { type: "agent", id: agentId, ...(agentVersion ? { version: agentVersion } : {}) },
        environment_id: environmentId,
        ...(vaultId ? { vault_ids: [vaultId] } : {}),
        title: sessionTitle,
      });

      let prompt: string;
      if (mode === "update") {
        const slugList = (params.sourceSlugs ?? []).map(s => `- ${s}`).join("\n");
        prompt = `Fetch release updates for the following sources:\n${slugList}\n\nFor each source, use the fetch_source tool with the source slug. Report the total releases found and any errors. Do NOT add, remove, or modify sources — only fetch.`;
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
              const sendResult = async (toolUseId: string, text: string) => {
                await (client.beta.sessions.events as any).send(session.id, {
                  events: [{
                    type: "user.custom_tool_result",
                    custom_tool_use_id: toolUseId,
                    content: [{ type: "text", text }],
                  }],
                });
              };
              const wasStateReport = await handleCustomToolUse(
                { id: toolEvent.id, name: toolEvent.name, input: toolEvent.input },
                {
                  sendResult,
                  executor,
                  onStateCapture: (state) => { capturedState = state; },
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

      // Archive session (agent + environment are long-lived, not archived)
      try { await (client.beta.sessions as any).archive(session.id); } catch { /* non-critical */ }

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

      // Update sessions don't require a state report — completing without one is fine
      if (mode === "update") {
        await this.ctx.storage.put("status", "complete");
        await this.notifyStatusHub({
          type: "session:complete",
          sessionId,
          company: params.company,
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
