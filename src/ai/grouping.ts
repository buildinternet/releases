import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { getAnthropicClient } from "./client.js";
import { config } from "@releases/lib/config";
import { logUsage } from "../lib/usage.js";
import { logger } from "@buildinternet/releases-lib/logger";

export interface GroupingCandidate {
  id: string;
  title: string;
  version: string | null;
  publishedAt: string | null;
  sourceSlug: string;
  content: string;
}

export interface GroupingCluster {
  canonicalId: string;
  coverageIds: string[];
  reason: string;
}

export interface GroupingResult {
  clusters: GroupingCluster[];
  model: string;
  rawResponse: string;
}

let cachedSkill: string | null = null;

function loadSkill(): string {
  if (cachedSkill !== null) return cachedSkill;

  const envDir = process.env.RELEASED_SKILLS_DIR;
  const candidates = [
    envDir && resolve(envDir, "grouping-releases/SKILL.md"),
    "/usr/share/releases/skills/grouping-releases/SKILL.md",
    resolve(homedir(), ".releases/skills/grouping-releases/SKILL.md"),
    resolve(import.meta.dir, "../agent/skills/grouping-releases/SKILL.md"),
  ].filter((p): p is string => !!p);

  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    throw new Error("grouping-releases SKILL.md not found on any conventional path");
  }
  cachedSkill = readFileSync(path, "utf8");
  return cachedSkill;
}

function formatCandidates(candidates: GroupingCandidate[]): string {
  return candidates.map((c) => {
    const contentSnippet = (c.content || "").slice(0, 400).replace(/\s+/g, " ").trim();
    return [
      `ID: ${c.id}`,
      `Title: ${c.title}`,
      `Version: ${c.version || "(none)"}`,
      `Source: ${c.sourceSlug}`,
      `Published: ${c.publishedAt?.slice(0, 10) || "(unknown)"}`,
      `Content: ${contentSnippet}`,
    ].join("\n");
  }).join("\n---\n");
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`no JSON object found in model response: ${body.slice(0, 200)}`);
  }
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * Parse a grouping agent response into clusters. Exported for tests.
 *
 * Treats `stop_reason === "max_tokens"` as a hard error — partial output can't
 * be trusted because the JSON array may be truncated mid-cluster (which surfaces
 * as a misleading `JSON Parse error: Expected ']'`). Callers should retry with
 * a higher max_tokens budget or chunk the candidate set.
 */
export function extractClustersFromResponse(
  rawResponse: string,
  stopReason: string | null | undefined,
): GroupingCluster[] {
  if (stopReason === "max_tokens") {
    throw new Error(
      "grouping: response truncated (stop_reason=max_tokens). Increase max_tokens or split the candidate set.",
    );
  }
  const parsed = extractJson(rawResponse) as { clusters?: Array<{ canonical_id?: string; coverage_ids?: string[]; reason?: string }> };
  const rawClusters = parsed.clusters;
  if (!Array.isArray(rawClusters)) {
    throw new Error(`model response missing "clusters" array: ${rawResponse.slice(0, 200)}`);
  }
  return rawClusters.map((c) => ({
    canonicalId: String(c.canonical_id || ""),
    coverageIds: Array.isArray(c.coverage_ids) ? c.coverage_ids.map(String) : [],
    reason: String(c.reason || "").trim(),
  }));
}

/**
 * Ask the model to cluster a set of candidate releases per the grouping-releases skill.
 * Validates that (1) every returned ID appears in the input, (2) every input ID appears
 * in exactly one cluster. Throws on violations so callers can retry or escalate to Sonnet.
 */
export async function groupReleases(
  candidates: GroupingCandidate[],
  opts: { model?: string; context?: string } = {},
): Promise<GroupingResult> {
  if (candidates.length === 0) {
    return { clusters: [], model: opts.model ?? "", rawResponse: "" };
  }

  const model = opts.model ?? config.groupingModel();
  const client = getAnthropicClient();
  const skill = loadSkill();

  const systemPrompt = [
    skill,
    "",
    "Respond with a single JSON object and nothing else. No markdown fences, no preamble.",
    'Shape: {"clusters": [{"canonical_id": "...", "coverage_ids": ["..."], "reason": "..."}, ...]}',
    "Every input release ID must appear in exactly one cluster — as either a canonical_id or a coverage_id, never both, never neither.",
  ].join("\n");

  const userMessage = [
    opts.context ? `Context: ${opts.context}` : null,
    "Candidate releases:",
    "",
    formatCandidates(candidates),
    "",
    "Apply the grouping-releases skill and return the JSON.",
  ].filter(Boolean).join("\n");

  const response = await client.messages.create({
    model,
    // 8192 is Haiku 4.5's per-response ceiling. Larger candidate sets that need
    // even more output budget should be split via the chunking caller, not by
    // pushing this number up against provider limits.
    max_tokens: 8192,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const rawResponse = textBlock?.type === "text" ? textBlock.text : "";

  await logUsage({
    operation: "release_grouping",
    model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    releaseCount: candidates.length,
  });

  const clusters = extractClustersFromResponse(rawResponse, response.stop_reason);
  validateClusters(clusters, candidates);

  logger.info(`grouping-releases: ${candidates.length} candidates → ${clusters.length} clusters via ${model}`);
  return { clusters, model, rawResponse };
}

/**
 * Exported for tests. Enforces the grouping-releases skill's "every ID appears in exactly
 * one cluster" contract and rejects hallucinated IDs so callers don't write bad data.
 */
export function validateClusters(clusters: GroupingCluster[], candidates: GroupingCandidate[]): void {
  const inputIds = new Set(candidates.map((c) => c.id));
  const seen = new Map<string, "canonical" | "coverage">();

  for (const cluster of clusters) {
    if (!cluster.canonicalId) {
      throw new Error("grouping: cluster missing canonical_id");
    }
    if (!inputIds.has(cluster.canonicalId)) {
      throw new Error(`grouping: canonical_id ${cluster.canonicalId} not in input set`);
    }
    if (seen.has(cluster.canonicalId)) {
      throw new Error(`grouping: ${cluster.canonicalId} appears in multiple clusters`);
    }
    seen.set(cluster.canonicalId, "canonical");

    for (const coverageId of cluster.coverageIds) {
      if (!inputIds.has(coverageId)) {
        throw new Error(`grouping: coverage_id ${coverageId} not in input set`);
      }
      if (seen.has(coverageId)) {
        throw new Error(`grouping: ${coverageId} appears in multiple clusters`);
      }
      if (coverageId === cluster.canonicalId) {
        throw new Error(`grouping: ${coverageId} listed as both canonical and coverage`);
      }
      seen.set(coverageId, "coverage");
    }
  }

  const missing = [...inputIds].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(`grouping: input IDs missing from output (${missing.length}): ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "..." : ""}`);
  }
}
