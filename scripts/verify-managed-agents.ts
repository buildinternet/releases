#!/usr/bin/env bun
/**
 * Verify the committed managed-agent YAML against the live agents.
 *
 * Phase 2 of the render-then-apply flow. Where render-managed-agents.ts proves
 * the YAML mirrors current *source* (the `--check` drift gate), this proves the
 * YAML matches what is actually *deployed* — the no-op confirmation you want
 * before switching the deploy's apply path, or a standing drift detector
 * between source and the live agents.
 *
 * Retrieval shells out to `ant beta:agents retrieve <id> --format json`, so it
 * targets whichever workspace the active `ant` profile (or $ANTHROPIC_API_KEY)
 * is bound to. The production discovery/worker agents live in a different Rally
 * workspace than the default OAuth login resolves to — bind to that workspace
 * (or export its API key) before verifying `--env production`, or those agents
 * report as UNREACHABLE.
 *
 * Each field diff is classified, not just flagged:
 *   - match        identical
 *   - api-default  live carries server-injected defaults the input form omits
 *                  (toolset `configs: []`, `permission_policy: always_allow`) —
 *                  benign; appears on every agent regardless of freshness.
 *   - source-ahead rendered (current source) has content live lacks → the live
 *                  agent predates a merged change; a redeploy reconciles it.
 *   - MISMATCH     anything else — a renderer bug or live drift to investigate.
 *
 * Exit code is non-zero only when a true MISMATCH is found. api-default and
 * source-ahead are reported but do not fail (stale staging is expected; the
 * point is to surface it, not to block).
 *
 * Usage:
 *   bun scripts/verify-managed-agents.ts                         # both envs, all kinds
 *   bun scripts/verify-managed-agents.ts --env staging
 *   bun scripts/verify-managed-agents.ts --env production --kind worker
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";
import type { AgentEnv } from "../src/shared/agent-tools.js";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

type AgentKind = "discovery" | "worker" | "coordinator";
const ALL_ENVS: AgentEnv[] = ["production", "staging"];
const ALL_KINDS: AgentKind[] = ["discovery", "worker", "coordinator"];

// Toolset entries whose input form legitimately omits keys the API injects on
// store. Differences confined to these keys are classified `api-default`.
const API_DEFAULT_KEYS = new Set(["configs", "permission_policy"]);

interface SkillConfig {
  agentId?: string;
  workerAgentId?: string;
  coordinatorAgentId?: string;
  environmentId?: string;
}

function loadConfig(env: AgentEnv): SkillConfig {
  const path = resolve(
    PROJECT_ROOT,
    env === "staging" ? "scripts/agent-skills.staging.json" : "scripts/agent-skills.json",
  );
  return JSON.parse(readFileSync(path, "utf8")) as SkillConfig;
}

function agentIdFor(kind: AgentKind, cfg: SkillConfig): string | undefined {
  if (kind === "discovery") return cfg.agentId;
  if (kind === "worker") return cfg.workerAgentId;
  return cfg.coordinatorAgentId;
}

function renderedPath(kind: AgentKind, env: AgentEnv): string {
  return resolve(PROJECT_ROOT, "managed-agents", `${kind}.${env}.agent.yaml`);
}

// Deterministic stringify (recursively key-sorted) for structural equality.
function sortKeys(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === "object") {
    return Object.fromEntries(
      Object.keys(o as Record<string, unknown>)
        .toSorted()
        .map((k: string) => [k, sortKeys((o as Record<string, unknown>)[k])]),
    );
  }
  return o;
}
const j = (v: unknown): string => JSON.stringify(sortKeys(v));

const skillKeys = (s: unknown): string[] =>
  (s as { skill_id: string; version: string }[]).map((x) => `${x.skill_id}@${x.version}`);

function firstDiff(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `diverges @${i}: rendered=${JSON.stringify(a.slice(i, i + 36))} live=${JSON.stringify(b.slice(i, i + 36))}`;
    }
  }
  return `common prefix matches; lengths rendered=${a.length} live=${b.length}`;
}

type Verdict = "match" | "api-default" | "source-ahead" | "MISMATCH";
interface Line {
  field: string;
  verdict: Verdict;
  note?: string;
}

const ICON: Record<Verdict, string> = {
  match: "✓",
  "api-default": "·",
  "source-ahead": "△",
  MISMATCH: "✗",
};

/** Retrieve a live agent via the `ant` CLI. Returns null when unreachable. */
function retrieveLive(id: string): Record<string, unknown> | null {
  let res;
  try {
    res = Bun.spawnSync(["ant", "beta:agents", "retrieve", id, "--format", "json"]);
  } catch {
    return null; // ant not installed / not on PATH
  }
  const out = res.stdout.toString().trim();
  if (!out) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  // `ant` prints the error body to stdout with exit 0 on a 404.
  if (!obj || obj.error || obj.type === "error" || !obj.id) return null;
  return obj;
}

function compareTool(r: Record<string, unknown>, l: Record<string, unknown>): Line | null {
  const name = (r.name ?? r.type) as string;
  if (j(r) === j(l)) return null;

  // Toolset entry (no input_schema): the API injects default keys on store
  // (top-level `configs: []`, a `permission_policy` inside `default_config`).
  // Strip those keys from BOTH sides — the input form may already set some of
  // them — then compare what remains. Equal after stripping ⇒ api-default.
  if (!r.input_schema) {
    const strip = (o: Record<string, unknown>): Record<string, unknown> => {
      const top = Object.fromEntries(Object.entries(o).filter(([k]) => !API_DEFAULT_KEYS.has(k)));
      const dc = top.default_config;
      if (dc && typeof dc === "object") {
        top.default_config = Object.fromEntries(
          Object.entries(dc as Record<string, unknown>).filter(([k]) => !API_DEFAULT_KEYS.has(k)),
        );
      }
      return top;
    };
    const liveOnly = Object.keys(l).filter((k) => !(k in r));
    if (j(strip(r)) === j(strip(l))) {
      return {
        field: `tool ${name}`,
        verdict: "api-default",
        note: `live adds ${liveOnly.join(", ") || "injected defaults"}`,
      };
    }
    return {
      field: `tool ${name}`,
      verdict: "MISMATCH",
      note: "toolset config differs beyond injected defaults",
    };
  }

  // Custom tool: compare input_schema property sets.
  // Set membership only — order irrelevant, so no sort needed.
  // `l.input_schema` may be absent even when `r`'s is present (a live toolset
  // paired at this index, or the `{}` fallback for a missing live tool) — guard
  // it so a missing schema reads as an empty property set instead of throwing.
  const rProps = Object.keys((r.input_schema as { properties?: object })?.properties ?? {});
  const lProps = Object.keys((l.input_schema as { properties?: object })?.properties ?? {});
  const renderedOnly = rProps.filter((k) => !lProps.includes(k));
  const liveOnly = lProps.filter((k) => !rProps.includes(k));
  if (liveOnly.length > 0) {
    return {
      field: `tool ${name}`,
      verdict: "MISMATCH",
      note: `live has props rendered lacks: ${liveOnly.join(", ")}`,
    };
  }
  if (renderedOnly.length > 0) {
    return {
      field: `tool ${name}`,
      verdict: "source-ahead",
      note: `live missing newer props: ${renderedOnly.join(", ")}`,
    };
  }
  // Same property set but some schema differs (enum/description change, etc.).
  return {
    field: `tool ${name}`,
    verdict: "source-ahead",
    note: "shared-prop schema differs (live behind source)",
  };
}

function compareAgent(
  kind: AgentKind,
  rendered: Record<string, unknown>,
  live: Record<string, unknown>,
): Line[] {
  const lines: Line[] = [];
  const eq = (field: string, a: unknown, b: unknown, note?: string): void => {
    lines.push({ field, verdict: j(a) === j(b) ? "match" : "MISMATCH", note });
  };

  eq("name", rendered.name, live.name, `${rendered.name}`);
  eq("model", rendered.model, (live.model as { id?: string }).id);
  eq("mcp_servers", rendered.mcp_servers, live.mcp_servers);

  eq(
    "skills",
    skillKeys(rendered.skills),
    skillKeys(live.skills),
    `${skillKeys(rendered.skills).length} skills`,
  );

  const sysOk = rendered.system === live.system;
  lines.push({
    field: "system",
    verdict: sysOk ? "match" : "source-ahead",
    note: sysOk
      ? `${(rendered.system as string).length} chars identical`
      : firstDiff(rendered.system as string, live.system as string),
  });

  const rTools = rendered.tools as Record<string, unknown>[];
  const lTools = live.tools as Record<string, unknown>[];
  lines.push({
    field: "tools",
    verdict:
      j(rTools.map((t) => t.name ?? t.type)) === j(lTools.map((t) => t.name ?? t.type))
        ? "match"
        : "MISMATCH",
    note: `${rTools.length} tools, sequence`,
  });
  for (let i = 0; i < rTools.length; i++) {
    const line = compareTool(rTools[i], lTools[i] ?? {});
    if (line) lines.push(line);
  }

  if (kind === "coordinator") {
    const rIds = ((rendered.multiagent as { agents?: { id: string }[] })?.agents ?? []).map(
      (a) => a.id,
    );
    const lIds = ((live.multiagent as { agents?: { id: string }[] })?.agents ?? []).map(
      (a) => a.id,
    );
    eq("multiagent.roster", rIds, lIds, j(rIds));
  }

  return lines;
}

function main(): void {
  const argv = process.argv.slice(2);
  const envArg = argv[argv.indexOf("--env") + 1];
  const kindArg = argv[argv.indexOf("--kind") + 1];
  const envs = argv.includes("--env") ? [envArg as AgentEnv] : ALL_ENVS;
  const kinds = argv.includes("--kind") ? [kindArg as AgentKind] : ALL_KINDS;

  let mismatches = 0;
  let unreachable = 0;

  for (const env of envs) {
    const cfg = loadConfig(env);
    for (const kind of kinds) {
      const id = agentIdFor(kind, cfg);
      const rendered = parse(readFileSync(renderedPath(kind, env), "utf8")) as Record<
        string,
        unknown
      >;
      console.log(`\n=== ${kind}.${env} (${id ?? "no id in config"}) ===`);
      if (!id) {
        console.log("  (skipped — no agent id in config)");
        continue;
      }
      const live = retrieveLive(id);
      if (!live) {
        console.log(
          "  UNREACHABLE — not found in the active workspace (wrong workspace, or `ant` not authed/installed).",
        );
        unreachable++;
        continue;
      }
      const lines = compareAgent(kind, rendered, live);
      for (const ln of lines) {
        if (ln.verdict === "MISMATCH") mismatches++;
        console.log(`  ${ICON[ln.verdict]} ${ln.field}${ln.note ? `  ${ln.note}` : ""}`);
      }
    }
  }

  console.log(
    `\nLegend: ${ICON.match} match  ${ICON["api-default"]} api-default (benign)  ${ICON["source-ahead"]} live behind source (redeploy reconciles)  ${ICON.MISMATCH} mismatch`,
  );
  if (unreachable > 0) console.log(`${unreachable} agent(s) unreachable in the active workspace.`);
  if (mismatches > 0) {
    console.error(`\n${mismatches} unexplained mismatch(es) — investigate.`);
    process.exit(1);
  }
  console.log("\nNo unexplained mismatches.");
}

main();
