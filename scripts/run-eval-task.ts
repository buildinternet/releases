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

// ── Cleanup helper ───────────────────────────────────────────────────────────

// Process-scoped snapshot store. Pre-run reads notes in; post-run writes them
// back. Kept simple: one key per org slug, overwritten on each snapshot call.
const playbookSnapshots = new Map<string, string | null>();

/**
 * Run the cleanup block for a task against the staging API. Best-effort:
 * 404 is swallowed (row absent is fine), other errors log to stderr but do
 * not abort the run.
 *
 * The `phase` parameter gates asymmetric steps — snapshot only runs pre, restore
 * only runs post. Symmetric kinds (delete_*, un*_url) run on both phases.
 */
async function runCleanup(t: (typeof TASKS)[number], phase: "pre" | "post"): Promise<void> {
  if (!t.cleanup || t.cleanup.length === 0) return;

  const baseUrl = "https://api";
  const authHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${stagingApiKey}`,
  };

  async function snapshotNotes(orgSlug: string): Promise<void> {
    const url = `${baseUrl}/v1/playbook?slug=${encodeURIComponent(orgSlug)}`;
    try {
      const res = await fetcher.fetch(url, { headers: authHeaders });
      if (!res.ok) {
        console.error(`cleanup: snapshot ${orgSlug} (error ${res.status})`);
        playbookSnapshots.set(orgSlug, null);
        return;
      }
      const body = (await res.json()) as { notes?: string | null } | null;
      playbookSnapshots.set(orgSlug, body?.notes ?? null);
      console.error(`cleanup: snapshot ${orgSlug} (ok)`);
    } catch (err) {
      console.error(`cleanup: snapshot ${orgSlug} (fetch error: ${(err as Error).message})`);
      playbookSnapshots.set(orgSlug, null);
    }
  }

  async function restoreNotes(orgSlug: string): Promise<void> {
    if (!playbookSnapshots.has(orgSlug)) {
      console.error(`cleanup: restore ${orgSlug} (skipped — no snapshot)`);
      return;
    }
    const notes = playbookSnapshots.get(orgSlug) ?? "";
    const url = `${baseUrl}/v1/playbook/notes?slug=${encodeURIComponent(orgSlug)}`;
    try {
      const res = await fetcher.fetch(url, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({ notes }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`cleanup: restore ${orgSlug} (error ${res.status}: ${body})`);
        return;
      }
      console.error(`cleanup: restore ${orgSlug} (ok)`);
    } catch (err) {
      console.error(`cleanup: restore ${orgSlug} (fetch error: ${(err as Error).message})`);
    }
  }

  function cleanupFetch(method: string, path: string): Promise<void> {
    const url = `${baseUrl}/v1${path}`;
    return fetcher
      .fetch(url, { method, headers: authHeaders })
      .then(async (res) => {
        if (res.status === 404) {
          console.error(`cleanup: ${method} ${path} (skipped 404)`);
          return;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.error(`cleanup: ${method} ${path} (error ${res.status}: ${body})`);
          return;
        }
        console.error(`cleanup: ${method} ${path} (ok)`);
      })
      .catch((err: Error) => {
        console.error(`cleanup: ${method} ${path} (fetch error: ${err.message})`);
      });
  }

  function deleteSource(step: { kind: string; args: Record<string, string> }): Promise<void> {
    // No direct "by URL" delete endpoint — look up matching source rows first.
    const { args } = step;
    const lookupUrl = `${baseUrl}/v1/sources?filterByUrls=true&url=${encodeURIComponent(args.url)}`;

    return fetcher
      .fetch(lookupUrl, { headers: authHeaders })
      .then(async (res) => {
        let rows: Array<{ slug: string; orgId: string | null }> = [];
        if (res.ok) {
          rows = (await res.json()) as typeof rows;
        } else if (res.status !== 404) {
          const body = await res.text().catch(() => "");
          console.error(`cleanup: lookup sources url=${args.url} (error ${res.status}: ${body})`);
        }

        // If orgSlug is provided, resolve it to an orgId and filter rows.
        if (!args.orgSlug || rows.length === 0) return rows;

        return fetcher
          .fetch(`${baseUrl}/v1/orgs/${encodeURIComponent(args.orgSlug)}`, {
            headers: authHeaders,
          })
          .then(async (orgRes) => {
            if (orgRes.ok) {
              const org = (await orgRes.json()) as { id: string };
              return rows.filter((r) => r.orgId === org.id);
            }
            if (orgRes.status !== 404) {
              const body = await orgRes.text().catch(() => "");
              console.error(
                `cleanup: lookup org slug=${args.orgSlug} (error ${orgRes.status}: ${body})`,
              );
            }
            return rows;
          })
          .catch((err: Error) => {
            console.error(`cleanup: lookup org slug=${args.orgSlug} (fetch error: ${err.message})`);
            return rows;
          });
      })
      .then((rows) => {
        if (!rows || rows.length === 0) {
          console.error(`cleanup: delete_source url=${args.url} (skipped 404)`);
          return Promise.resolve();
        }
        return Promise.all(
          rows.map((row) => cleanupFetch("DELETE", `/sources/${encodeURIComponent(row.slug)}`)),
        ).then(() => undefined);
      })
      .catch((err: Error) => {
        console.error(`cleanup: lookup sources url=${args.url} (fetch error: ${err.message})`);
      });
  }

  await Promise.all(
    t.cleanup.map((step) => {
      const { kind, args } = step;
      if (kind === "delete_org") {
        return cleanupFetch("DELETE", `/orgs/${encodeURIComponent(args.slug)}`);
      }
      if (kind === "unblock_url") {
        return cleanupFetch("DELETE", `/blocked-urls/${encodeURIComponent(args.pattern)}`);
      }
      if (kind === "unignore_url") {
        return cleanupFetch(
          "DELETE",
          `/orgs/${encodeURIComponent(args.orgSlug)}/ignored-urls/${encodeURIComponent(args.url)}`,
        );
      }
      if (kind === "delete_source") {
        // Prefer a slug hit — it's a direct DELETE and can't match unrelated
        // rows. Fall back to URL lookup only when the fixture has no slug.
        if (args.slug) {
          return cleanupFetch("DELETE", `/sources/${encodeURIComponent(args.slug)}`);
        }
        return deleteSource(step);
      }
      if (kind === "snapshot_playbook_notes") {
        return phase === "pre" ? snapshotNotes(args.orgSlug) : Promise.resolve();
      }
      if (kind === "restore_playbook_notes") {
        return phase === "post" ? restoreNotes(args.orgSlug) : Promise.resolve();
      }
      return Promise.resolve();
    }),
  );
}

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

  // Pre-run cleanup: clear any stale rows from a previous run before the agent starts.
  console.error("pre-run cleanup...");
  await runCleanup(task!, "pre");

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

  // Post-run cleanup: leave staging in the same clean state for the next run.
  console.error("post-run cleanup...");
  await runCleanup(task!, "post");
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
