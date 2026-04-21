#!/usr/bin/env bun
/**
 * Dispatch one tool-UX eval task to a managed agent, stream the session,
 * dispatch custom-tool calls through the typed executor (so the agent can
 * actually complete its work), and write the raw event list + derived
 * metrics to a JSON file.
 *
 * Env required:
 *   ANTHROPIC_API_KEY, ANTHROPIC_ENVIRONMENT_ID, ANTHROPIC_VAULT_ID
 *   RELEASED_STAGING_API_URL  (eval dispatch always targets staging)
 *   RELEASED_API_KEY          (bearer for staging API)
 *   STAGING_ACCESS_KEY        (X-Releases-Staging-Key header)
 *
 * Usage:
 *   bun scripts/run-eval-task.ts <task-id> --agent <agent-id> [--out <path>]
 */

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTypedExecutor, handleCustomToolUse } from "../src/shared/agent-tools.ts";
import { TASKS } from "../tests/evals/fixtures/tool-ux/tasks.ts";

const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return v;
}

const taskId = process.argv[2];
if (!taskId || taskId.startsWith("--")) {
  console.error("Usage: bun scripts/run-eval-task.ts <task-id> --agent <id> [--out <path>]");
  console.error("\nAvailable task ids:");
  for (const t of TASKS) console.error(`  ${t.id}`);
  process.exit(1);
}

const task = TASKS.find((t) => t.id === taskId);
if (!task) {
  console.error(`Unknown task: ${taskId}`);
  process.exit(1);
}

const agentId = arg("--agent") ?? process.env.ANTHROPIC_AGENT_ID;
if (!agentId) {
  console.error("Pass --agent <id> or set ANTHROPIC_AGENT_ID");
  process.exit(1);
}

const outPath = arg("--out") ?? `tests/evals/fixtures/tool-ux/runs/${taskId}-${Date.now()}.json`;

const anthropicApiKey = requireEnv("ANTHROPIC_API_KEY");
const environmentId = requireEnv("ANTHROPIC_ENVIRONMENT_ID");
const vaultId = process.env.ANTHROPIC_VAULT_ID;
const stagingApiUrl = requireEnv("RELEASED_STAGING_API_URL").replace(/\/+$/, "");
const stagingApiKey = requireEnv("RELEASED_API_KEY");
const stagingAccessKey = requireEnv("STAGING_ACCESS_KEY");

// Executor talks to the staging API worker via global fetch, attaching the
// staging gate header on every request.
const fetcher = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input.replace(/^https:\/\/api/, stagingApiUrl)
        : input instanceof URL
          ? new URL(input.toString().replace(/^https:\/\/api/, stagingApiUrl))
          : input;
    const headers = new Headers(init?.headers ?? {});
    headers.set("X-Releases-Staging-Key", stagingAccessKey);
    return globalThis.fetch(url as RequestInfo | URL, { ...init, headers });
  },
};

const client = new Anthropic({ apiKey: anthropicApiKey });

// Collect every session event so we can save the raw trace alongside metrics.
const events: Array<Record<string, unknown>> = [];

async function main(): Promise<void> {
  console.error(`task:    ${task!.id}`);
  console.error(`agent:   ${agentId}`);
  console.error(`target:  ${stagingApiUrl}`);

  const session = await (client.beta.sessions as any).create({
    agent: agentId,
    environment_id: environmentId,
    ...(vaultId ? { vault_ids: [vaultId] } : {}),
    title: `eval: ${task!.id}`,
  });
  const sessionId = session.id as string;
  console.error(`session: ${sessionId}\n`);

  const executor = createTypedExecutor({ fetcher, apiKey: stagingApiKey, sessionId });

  const stream = await (client.beta.sessions.events as any).stream(sessionId);
  await (client.beta.sessions.events as any).send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text: task!.prompt }] }],
  });

  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  const timeoutId = setTimeout(() => {
    try {
      stream.controller.abort();
    } catch {
      /* closed */
    }
  }, SESSION_TIMEOUT_MS);

  try {
    for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
      if (Date.now() > deadline) {
        console.error("[timeout reached]");
        break;
      }
      events.push(event);

      const type = event.type as string;
      if (type === "agent.custom_tool_use") {
        const toolEvent = event as { id: string; name: string; input?: Record<string, unknown> };
        console.error(`  → ${toolEvent.name}`);
        await handleCustomToolUse(
          { id: toolEvent.id, name: toolEvent.name, input: toolEvent.input },
          {
            executor,
            sendResult: async (toolUseId, text) => {
              await (client.beta.sessions.events as any).send(sessionId, {
                events: [
                  {
                    type: "user.custom_tool_result",
                    custom_tool_use_id: toolUseId,
                    content: [{ type: "text", text }],
                  },
                ],
              });
            },
          },
        );
      } else if (type === "agent.tool_use") {
        console.error(`  · ${(event as { name?: string }).name ?? "(builtin)"}`);
      } else if (type === "session.status_idle") {
        const stopReason = (event as { stop_reason?: { type?: string } }).stop_reason?.type;
        if (stopReason !== "requires_action") {
          console.error(`[idle: ${stopReason ?? "end_turn"}]`);
          break;
        }
      } else if (type === "session.status_terminated" || type === "session.error") {
        console.error(`[${type}]`, event);
        break;
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        taskId: task!.id,
        agentId,
        sessionId,
        startedAt: new Date().toISOString(),
        prompt: task!.prompt,
        events,
        metrics: deriveMetrics(events),
      },
      null,
      2,
    ),
  );
  console.error(`\nwrote ${outPath}`);
}

function deriveMetrics(sessionEvents: Array<Record<string, unknown>>) {
  let input = 0;
  let output = 0;
  let cacheCreate = 0;
  let cacheRead = 0;
  const customToolCalls: string[] = [];
  const builtinToolCalls: string[] = [];
  let firstTs: string | undefined;
  let lastTs: string | undefined;

  for (const ev of sessionEvents) {
    const ts = ev.processed_at as string | undefined;
    if (ts) {
      firstTs ??= ts;
      lastTs = ts;
    }
    if (ev.type === "span.model_request_end") {
      const u = (ev as { model_usage?: Record<string, number> }).model_usage;
      if (u) {
        input += u.input_tokens ?? 0;
        output += u.output_tokens ?? 0;
        cacheCreate += u.cache_creation_input_tokens ?? 0;
        cacheRead += u.cache_read_input_tokens ?? 0;
      }
    }
    if (ev.type === "agent.custom_tool_use") {
      customToolCalls.push((ev as { name: string }).name);
    }
    if (ev.type === "agent.tool_use") {
      builtinToolCalls.push((ev as { name: string }).name);
    }
  }

  const elapsedMs =
    firstTs && lastTs ? new Date(lastTs).getTime() - new Date(firstTs).getTime() : 0;

  return {
    customToolCalls,
    builtinToolCalls,
    customToolCount: customToolCalls.length,
    builtinToolCount: builtinToolCalls.length,
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheCreationTokens: cacheCreate,
      cacheReadTokens: cacheRead,
      total: input + output + cacheCreate + cacheRead,
    },
    elapsedMs,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
