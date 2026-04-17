import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { config } from "@releases/lib/config";
import { logger } from "@buildinternet/releases-lib/logger";
import { getAnthropicClient } from "./client.js";

/**
 * Classifies ambiguous release-page media via the `classify-media-relevance` skill.
 *
 * The skill spec lives at `src/agent/skills/classify-media-relevance/SKILL.md`.
 * Cheap deterministic pre-checks happen in `src/lib/media.ts` — only items that
 * the pre-check classifier marks as "ambiguous" should reach this function.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface MediaClassifyInput {
  url: string;
  alt?: string;
  type: "image" | "video" | "gif";
}

export interface MediaClassifyContext {
  /** Release title for context. */
  releaseTitle?: string;
  /** Optional release body — a trimmed excerpt is fine; classifier only needs context. */
  releaseContent?: string;
  /** Source slug for logging. */
  sourceSlug?: string;
}

export type MediaDecision = "keep" | "drop";

export interface MediaClassification {
  url: string;
  decision: MediaDecision;
  confidence: "high" | "low";
  reason: string;
}

// ── Skill loading ───────────────────────────────────────────────────

let cachedSkillText: string | null = null;

function loadSkillText(): string | null {
  if (cachedSkillText) return cachedSkillText;

  const envDir = process.env.RELEASED_SKILLS_DIR;
  const candidates = [
    envDir && resolve(envDir, "classify-media-relevance/SKILL.md"),
    "/usr/share/releases/skills/classify-media-relevance/SKILL.md",
    resolve(homedir(), ".releases/skills/classify-media-relevance/SKILL.md"),
    resolve(import.meta.dir, "../agent/skills/classify-media-relevance/SKILL.md"),
  ].filter((p): p is string => !!p);

  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    logger.debug("classify-media: SKILL.md not found on any conventional path");
    return null;
  }
  try {
    cachedSkillText = readFileSync(path, "utf8");
    return cachedSkillText;
  } catch (err) {
    logger.debug("classify-media: failed to read SKILL.md", err);
    return null;
  }
}

// ── Classification ──────────────────────────────────────────────────

const SYSTEM_PREAMBLE = `You are a media relevance classifier for a changelog indexer. Your job is to decide, for each media item on a release page, whether it is editorial content (screenshots, demos, diagrams, product shots) or site chrome (avatars, logos, tracking pixels, decorative badges).

You will be given the skill spec below, plus a JSON array of ambiguous media items. Apply the spec's classification rules and return a JSON array of decisions in the same order. Each decision must include: url, decision ("keep" or "drop"), confidence ("high" or "low"), and reason (one short sentence).

Return ONLY a valid JSON array. No prose, no markdown fences.

── classify-media-relevance skill spec ──

`;

/**
 * Calls the classify-media-relevance skill on a batch of ambiguous media items.
 * Returns an array of decisions in the same order as `items`.
 *
 * If the Anthropic client or skill spec is unavailable, returns `null` — callers
 * should treat null as "keep all" (conservative fallback, matches the skill's
 * precision-over-recall anti-pattern guidance).
 */
export async function classifyAmbiguousMedia(
  items: MediaClassifyInput[],
  ctx: MediaClassifyContext = {},
): Promise<MediaClassification[] | null> {
  if (items.length === 0) return [];

  const skillText = loadSkillText();
  if (!skillText) return null;

  if (!config.anthropicApiKey()) {
    logger.debug("classify-media: ANTHROPIC_API_KEY not set — skipping classifier");
    return null;
  }

  let client: ReturnType<typeof getAnthropicClient>;
  try {
    client = getAnthropicClient();
  } catch (err) {
    logger.debug("classify-media: failed to build Anthropic client", err);
    return null;
  }

  const ctxBlock = [
    ctx.releaseTitle ? `Release title: ${ctx.releaseTitle}` : null,
    ctx.sourceSlug ? `Source: ${ctx.sourceSlug}` : null,
    ctx.releaseContent
      ? `Release content excerpt:\n${ctx.releaseContent.slice(0, 1500)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const itemsBlock = JSON.stringify(items, null, 2);

  try {
    const response = await client.messages.create({
      model: config.ingestModel(),
      max_tokens: 2048,
      system: [
        {
          type: "text",
          text: SYSTEM_PREAMBLE + skillText,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `${ctxBlock ? ctxBlock + "\n\n" : ""}<ambiguous_media>\n${itemsBlock}\n</ambiguous_media>\n\nReturn the JSON decisions array.`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      logger.debug("classify-media: no text block in response");
      return null;
    }

    const parsed = parseDecisions(textBlock.text);
    if (!parsed) return null;

    // Align by URL (defensive — models sometimes reorder).
    const byUrl = new Map(parsed.map((d) => [d.url, d]));
    return items.map((item) => {
      const decision = byUrl.get(item.url);
      if (decision) return decision;
      return {
        url: item.url,
        decision: "keep" as const,
        confidence: "low" as const,
        reason: "classifier did not return a decision — keeping conservatively",
      };
    });
  } catch (err) {
    logger.debug("classify-media: Anthropic call failed", err);
    return null;
  }
}

function parseDecisions(text: string): MediaClassification[] | null {
  // Strip markdown fences if the model wrapped the array.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) return null;
  const jsonSlice = cleaned.slice(firstBracket, lastBracket + 1);
  let raw: unknown;
  try {
    raw = JSON.parse(jsonSlice);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const decisions: MediaClassification[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url : null;
    const decision = rec.decision === "keep" || rec.decision === "drop" ? rec.decision : null;
    if (!url || !decision) continue;
    decisions.push({
      url,
      decision,
      confidence: rec.confidence === "high" ? "high" : "low",
      reason: typeof rec.reason === "string" ? rec.reason : "",
    });
  }
  return decisions.length > 0 ? decisions : null;
}
