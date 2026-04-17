import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
let cachedSkill: string | null = null;

function loadSkill(): string {
  if (cachedSkill !== null) return cachedSkill;
  // Skill content is the same file the managed agents consume; loading it here
  // keeps one copy as the source of truth for both the CLI path and any future
  // agent-tool path that invokes grouping.
  const skillPath = join(__dirname, "..", "agent", "skills", "grouping-releases", "SKILL.md");
  cachedSkill = readFileSync(skillPath, "utf8");
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
    max_tokens: 4096,
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

  const parsed = extractJson(rawResponse) as { clusters?: Array<{ canonical_id?: string; coverage_ids?: string[]; reason?: string }> };
  const rawClusters = parsed.clusters;
  if (!Array.isArray(rawClusters)) {
    throw new Error(`model response missing "clusters" array: ${rawResponse.slice(0, 200)}`);
  }

  const clusters: GroupingCluster[] = rawClusters.map((c) => ({
    canonicalId: String(c.canonical_id || ""),
    coverageIds: Array.isArray(c.coverage_ids) ? c.coverage_ids.map(String) : [],
    reason: String(c.reason || "").trim(),
  }));

  validateClusters(clusters, candidates);

  logger.info(`grouping-releases: ${candidates.length} candidates → ${clusters.length} clusters via ${model}`);
  return { clusters, model, rawResponse };
}

function validateClusters(clusters: GroupingCluster[], candidates: GroupingCandidate[]): void {
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
