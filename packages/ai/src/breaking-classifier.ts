/**
 * Per-release breaking-change classifier (#1696) — Haiku 4.5 verdict on whether
 * a release is safe to take and, if not, what a consumer must migrate. Produces
 * the `releases.breaking` level (`none` | `minor` | `major`, or `unknown` when
 * undeterminable) and an extracted `migrationNotes` string (null unless the body
 * explicitly describes upgrade steps).
 *
 * This is the data layer the upgrade-plan / `whats_changed` feature (#1697)
 * stands on, and first-party editorial value in its own right (the signal an
 * agent upgrading a manifest most wants).
 *
 * Called from the live poll-fetch ingest path, AFTER the caller has confirmed
 * the source kind qualifies (see `qualifiesForBreakingClassification` in
 * `@buildinternet/releases-core/kinds`) — consumer apps / docs never reach here.
 * It is NOT wired into the batch backfill path: history stays `unknown` until a
 * separate, cost-estimated run populates it (deferred, #1696).
 *
 * Worker-safe: no `fs`, no `node:*`, no logger. The caller constructs the
 * `TextModel` (so the worker routes through AI Gateway / a cheap OpenRouter
 * model on the shared summarize lane), and the caller is responsible for
 * fail-open behavior on a thrown transport error — parse is already fail-open
 * here (`unknown` is the safe verdict, never an exception).
 */

import { isEmptyContent } from "./release-content";
import type { TextModel, TextModelUsage } from "./text-model";
import { isBreakingLevel, type BreakingLevel } from "@buildinternet/releases-core/breaking";

/** Anthropic fallback model id. The worker resolves the shared summarize lane
 *  (SUMMARIZE_MODEL → this Haiku) with a distinct `generationName`; no per-feature model var. */
export const MODEL = "claude-haiku-4-5";

/** Maximum characters of release body sent to the model (truncated at this length). */
export const MAX_BODY_CHARS = 8000;

/** Cap on the model's response — a one-word verdict plus a short migration note. */
export const MAX_OUTPUT_TOKENS = 256;

/** Migration-note sentinels the model emits when there are no explicit upgrade steps. */
const NO_MIGRATION = new Set(["", "none", "n/a", "na", "null"]);

export interface BreakingClassifyInput {
  /** Human-readable source label ("OpenAI Node SDK", "Next.js"). Anchors the model on the product. */
  sourceName: string;
  /** Set only when an org groups multiple products through one source. */
  productName: string | null;
  title: string;
  version: string | null;
  /** Release-notes body (markdown). Truncated to `MAX_BODY_CHARS`. */
  content: string;
}

export type BreakingClassifierUsage = TextModelUsage;

export interface BreakingClassifyResult {
  /** Classified risk level. `unknown` on empty body, unparseable output, or genuine uncertainty. */
  breaking: BreakingLevel;
  /** Explicit upgrade/migration steps lifted from the body, or null when the body gives none. */
  migrationNotes: string | null;
  usage: BreakingClassifierUsage;
  /** True when `isEmptyContent` short-circuited and no model call was made. */
  skipped: boolean;
}

/**
 * The system prompt. Exported so cross-provider evaluations can hold the prompt
 * constant and vary the model.
 */
export const SYSTEM_PROMPT = `You classify the upgrade risk of a single software release from its release notes, for a developer-facing changelog index. The reader is an engineer (or an agent on their behalf) asking one question: "can I take this upgrade safely, and if not, what do I have to change?"

<verdict_levels>
Output exactly one level:

- **major** — taking this upgrade WILL break a consumer who does nothing. Removals of public API/CLI/config, renamed or changed function/method signatures, changed return shapes, dropped runtime/platform/dependency support (e.g. "drops Node 18", "requires Postgres 14+"), required config or data migrations, and DEFAULT-BEHAVIOR REVERSALS that change output for existing users. Semver-major-worthy.
- **minor** — a break that affects only an edge case or a narrow surface, OR a deprecation that still works this release (announced, shimmed, warns) but will be removed later. Most consumers upgrade with no change; a few must act.
- **none** — no breaking changes. Additive features, bug fixes, performance, and docs that don't alter an existing contract. The common case.
- **unknown** — you genuinely cannot tell from the body (too vague, no detail, marketing-only). Prefer this over guessing.
</verdict_levels>

<bias>
Precision over recall. A false "major"/"minor" (crying wolf) is WORSE than a false "unknown" — it makes an agent distrust the signal. When torn between two levels, pick the LOWER-risk one you can defend from the body's own words. When the body is too vague to support any verdict, output unknown — never invent a break that the notes don't state.

Do not infer a break from a version number alone (a 2.0.0 is not automatically "major"). Classify from what the notes SAY changed, not from semver.
</bias>

<migration>
If — and only if — the body explicitly describes how to upgrade (a "Migration" / "Upgrading" / "Breaking changes" section, before/after code, "replace X with Y", "set flag Z", "run command W"), distill those steps into 1–3 plain sentences in a <migration> tag. Use the body's own instructions; do not invent steps. If the body states a break but gives no upgrade instructions, or there is no break, output <migration>none</migration>.
</migration>

<output_structure>
Output exactly one <breaking>...</breaking> tag containing one of: major, minor, none, unknown — then one <migration>...</migration> tag. Output nothing before, between, or after these two tags. No prose, no explanation, no markdown.
</output_structure>

<examples>
<example>
<input>Source: OpenAI Node SDK
Title: v5.0.0
Version: 5.0.0
Body:
### Breaking changes
- \`openai.completions.create\` is removed; use \`openai.chat.completions.create\`.
- The client now requires Node 20+ (dropped Node 18).
### Migration
Replace any \`completions.create({ prompt })\` calls with \`chat.completions.create({ messages })\`. Upgrade your runtime to Node 20.</input>
<output>
<breaking>major</breaking>
<migration>Replace openai.completions.create({ prompt }) calls with openai.chat.completions.create({ messages }). Upgrade the runtime to Node 20 or later.</migration>
</output>
</example>

<example>
<input>Source: Next.js
Title: v15.4.2
Version: 15.4.2
Body:
- Fixed a hydration mismatch in the App Router.
- Added a new \`images.qualities\` config option.
- The \`legacyBehavior\` prop on next/link is now deprecated and will be removed in v16. It still works for now.</input>
<output>
<breaking>minor</breaking>
<migration>none</migration>
</output>
</example>

<example>
<input>Source: Stripe CLI
Title: v1.21.0
Version: 1.21.0
Body:
- Add \`stripe listen --skip-verify\` flag.
- Improve error messages on failed webhook deliveries.
- Performance: faster startup.</input>
<output>
<breaking>none</breaking>
<migration>none</migration>
</output>
</example>

<example>
<input>Source: Acme Platform
Title: April release
Version:
Body: This month we shipped a bunch of improvements to make Acme faster and more delightful. Thanks to all our users!</input>
<output>
<breaking>unknown</breaking>
<migration>none</migration>
</output>
</example>
</examples>`;

/** Render the user-message block from a release. Exported for evaluation parity. */
export function buildBreakingBlock(input: BreakingClassifyInput): string {
  const body =
    input.content.length > MAX_BODY_CHARS
      ? input.content.slice(0, MAX_BODY_CHARS) + "\n\n[truncated]"
      : input.content;

  const productLine =
    input.productName && input.productName !== input.sourceName
      ? `Product: ${input.productName}`
      : null;

  return [
    `Source: ${input.sourceName}`,
    productLine,
    `Title: ${input.title}`,
    input.version ? `Version: ${input.version}` : null,
    "",
    "Body:",
    body,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Pull `<breaking>` + `<migration>` out of the model output. Fail-open by
 * design: an absent or unrecognized `<breaking>` value maps to `"unknown"`
 * (the safe verdict) rather than throwing — `unknown` IS a valid level, so a
 * miss should never propagate as an error. `migrationNotes` is null unless the
 * model returned real upgrade steps.
 *
 * Note: extracting `<breaking>` directly (not gating on `unknown`) lets the
 * model's own `unknown` and a parse miss collapse to the same safe value.
 */
export function parseBreaking(raw: string): {
  breaking: BreakingLevel;
  migrationNotes: string | null;
} {
  const verdict = extractFirstTag(raw, "breaking").toLowerCase();
  const breaking: BreakingLevel = isBreakingLevel(verdict) ? verdict : "unknown";

  // No migration steps are meaningful when there's no break (or we don't know).
  if (breaking === "none" || breaking === "unknown") {
    return { breaking, migrationNotes: null };
  }

  const note = extractFirstTag(raw, "migration").trim();
  const migrationNotes = NO_MIGRATION.has(note.toLowerCase()) ? null : note;
  return { breaking, migrationNotes };
}

/** Local tag reader — release-content's `extractTagged` is equivalent, but this
 *  module avoids importing it so the two parsers stay independently changeable. */
function extractFirstTag(text: string, tag: string): string {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return (m?.[1] ?? "").trim();
}

/**
 * Classify one release's breaking-change risk. The caller constructs the
 * `TextModel` (shared summarize lane) and is expected to have already gated on
 * source kind. Empty/boilerplate bodies short-circuit to `unknown` with no
 * model call (`skipped: true`). Parse is fail-open; a transport error throws and
 * the caller should catch and fall open to `unknown` (the live ingest path wraps
 * this call in its own try/catch so a classify failure never disturbs the
 * summary write).
 */
export async function classifyBreaking(
  model: TextModel,
  input: BreakingClassifyInput,
): Promise<BreakingClassifyResult> {
  if (isEmptyContent(input.content)) {
    return {
      breaking: "unknown",
      migrationNotes: null,
      usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
      skipped: true,
    };
  }

  const { text: raw, usage } = await model.complete({
    system: SYSTEM_PROMPT,
    user: buildBreakingBlock(input),
    maxTokens: MAX_OUTPUT_TOKENS,
    cacheSystem: true,
  });

  return { ...parseBreaking(raw), usage, skipped: false };
}
