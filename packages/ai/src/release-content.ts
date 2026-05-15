/**
 * Generate `title_generated`, `title_short`, and `summary`
 * for a release row via Anthropic Haiku 4.5 + a tuned system prompt.
 *
 * Used by:
 *   - `scripts/generate-release-content.ts` — operational backfill / rerun
 *   - the API worker's poll-fetch / scrape-agent workflows (per-org opt-in)
 *
 * Worker-safe: no `fs`, no `node:*` imports, no logger. Caller constructs
 * the Anthropic client so the script can route directly and the worker
 * can route through AI Gateway via `@buildinternet/releases-lib/anthropic-client`.
 */

import type Anthropic from "@anthropic-ai/sdk";

/** Model id used by the live and batch release-content paths. Exported so the
 *  backfill script can submit identical request shapes through the Batches API. */
export const MODEL = "claude-haiku-4-5";

/** Maximum characters of release body sent to the model (truncated at this length). */
export const MAX_BODY_CHARS = 8000;

/** Cap on the model's response. Sized for ~80-char title + ~70-char short + 1-2 sentence summary in tagged XML. */
export const MAX_OUTPUT_TOKENS = 220;

// In-prompt sentinel emitted by the model when the body is boilerplate-only.
// The empty-body short-circuit (isEmptyContent) is a separate path — those
// rows skip the model entirely and return all-null fields.
const EMPTY_BODY_FALLBACK = "Release notes do not describe the change.";

// Strings that, when they are the entire normalized body, indicate no real
// release-note content. Compared lowercase after stripping markdown / HTML
// comments / badges.
const BOILERPLATE_BODIES = new Set([
  "chore",
  "n/a",
  "na",
  "none",
  "tbd",
  "wip",
  "internal",
  "internal release",
  "no notes",
  "no release notes",
  "dependencies",
  "dependency update",
  "dependency updates",
  "updated dependencies",
]);

/**
 * True when a body has no real release-note content — used to skip the AI
 * call entirely. Strips markdown, HTML comments, and badge syntax before
 * checking whether any alphabetic words remain.
 */
export function isEmptyContent(raw: string): boolean {
  let s = raw.trim();
  if (!s) return true;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // images / badges
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links — keep label so "[Foo](url)" doesn't read as empty
  s = s.replace(/[#*_`~|>]+/g, " ");
  s = s.replace(/\b[vV]?\d+(\.\d+)+\S*\b/g, " "); // bare version tokens
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  if (!s) return true;
  if (BOILERPLATE_BODIES.has(s)) return true;
  const words = s.match(/[a-z]{3,}/g) ?? [];
  return words.length === 0;
}

/**
 * The production system prompt. Exported so cross-provider evaluations can keep
 * the prompt constant as the comparison axis (see issue #851).
 */
export const SYSTEM_PROMPT = `You write a title, a short title, and a summary for a release-notes entry, used in a developer-facing changelog index.

<output_structure>
Output exactly one <title>...</title> tag, then one <title_short>...</title_short> tag, then one <summary>...</summary> tag, in that order. Output nothing before, between, or after these tags.
</output_structure>

<title_format>
The release block includes Org, Source, optionally Product, Title, Version, URL, and Body. Source is the human-readable product label (e.g. "Claude Code", "OpenAI Node SDK", "Next.js") that should appear in the headline; Product is set only when an org groups multiple products through one source. Prefer Product when present, otherwise Source. Use these to construct a self-contained news headline.

- News-headline style: lead with the product (and version when applicable), then a verb-led description of the most important change.
- Reader test: someone seeing this title in isolation, with no surrounding context, should know what changed and which product it concerns. A title like "v2.1.128" or "Various improvements" fails this test.
- Include the version when the source title carries one. Drop redundant prefixes (don't repeat the product name twice if it's already in the source title).
- Sentence case for body words. Preserve product names, proper nouns, and standard acronyms (API, CLI, MCP, SDK, TUI) as they appear in the body.
- Target 60-90 characters. Hard cap at 100.
- No trailing punctuation. No quotation marks. No markdown.
- For empty or chore-only bodies, write a formulaic title using product + version: e.g., "Next.js v15.4.2 dependency update", "OpenAI Codex 2.35.1 internal release".
</title_format>

<title_short_format>
The title_short is a punchy headline assertion in Axios "smart brevity" style, used on surfaces (org pages, product pages, release detail cards) where the product and version are already shown elsewhere in the UI.

Style rules:

1. **Lead with the most specific noun (the thing that changed) or the outcome — not with a generic verb like "Fixes", "Adds", "Improves".** "Fixes worktree bug that dropped commits" → "Worktree no longer drops unpushed commits". The noun does the work.

2. **Active voice. Concrete outcome over mechanism.** Say what now happens, not what was done. "Adds caching for the Messages API" → "Messages API now caches automatically". Reserve "Fixed X" only when the outcome is awkward to phrase as a state ("imagegen size enum regression fixed" is fine — there's no clean before/after).

3. **Drop articles ("the", "a") wherever the meaning is clear without them.**

4. **Join two clauses with a semicolon (";") or em-dash ("—"), not "and".** Reserve "and" for tightly-related items inside a single clause ("vision and coding").

5. **Telegraphic register.** One factual claim per clause. No connector phrases ("a number of", "various", "multiple"). No marketing intensifiers ("major", "important", "exciting", "significant").

6. **Hard cap at 70 characters. Target 30-60.** Smart brevity is character-economical by design.

7. **Smart brevity DOES NOT apply to documentation pages, blog posts, marketing announcements, or guide content.** For those, write a natural noun-led phrase. Reserve smart brevity for releases that have a clear before/after — bug fixes, feature additions, deprecations.

8. **For empty/chore-only fallbacks, the short form is "Dependency update" or "Internal release".**

Smart brevity transformations to internalize:
- "Fixes worktree bug that was dropping unpushed commits" → "Worktree no longer drops unpushed commits"
- "Adds Admin API Keys support and fixes auth type checks" → "Admin API keys per endpoint; auth type checks fixed"
- "Fixes MCP server configuration loss and OAuth token refresh concurrency" → "MCP servers persist after /clear; OAuth refresh hardened"
</title_short_format>

<summary_format>
- Begin with the change itself. No opening phrases like "Here is", "This release", or "Based on the notes".
- Do not restate the version, product, or title — those appear separately in the UI.
- Use exactly one or two sentences. The second is optional, used only when one cannot carry the most important change.
- Plain factual prose with standard sentence punctuation. No markdown, no bullet lists, no JSON, no parentheticals, no headers.
- The summary is *reporting density* — it explains the mechanism (which file, which command, which API) and includes the second-tier change or long-tail characterization. The short title is the headline-density form; the summary adds technical depth.
</summary_format>

<priority_order>
For all three outputs, when picking what to surface, apply this ranked order:

1. Breaking changes, deprecations, removals.
2. Security or data-loss fixes.
3. New user-facing capabilities or APIs.
4. Crash or correctness fixes that block real workflows.
5. UI / quality-of-life improvements.
6. Internal refactors, chores, dependency bumps — drop entirely.

**Scan-first rule.** Before choosing the lead, sweep the entire body for items that often hide in feature-addition framing or technical language but are actually higher priority:

- **Default behavior reversals are #1.** Lines like "the default X changes back to Y", "is now opt-in (was automatic)", "no longer enabled by default", "default reverted to" — these are breaking changes for users on the prior version, even when the line is phrased as "Added X setting". When you see "Added [setting] (note: default changes…)", the news is the default change, not the setting.
- **Deprecations and removals are #1.** Lines mentioning "removed", "no longer supported", "retired", "deprecated", "will be retired on [date]".
- **Data-loss-tier bugs are #2.** Lines mentioning memory leaks ("unbounded memory growth", "10GB+ RSS"), credential races, refresh-token loss, OAuth state corruption, session corruption, or anything that loses user state silently. These are #2 priority and lead over #4 correctness fixes, even when the description is in technical jargon.

Lead with whatever the highest priority tier surfaces, even if it is buried mid-list, described as a feature addition, or written in technical jargon.

For long bullet lists (more than ~10 items): pick the single most user-impacting item by this ranking and lead with it. Do not serialize the first few items in source order. Cosmetic items must never appear before fixes from rows 1-4 of the priority list, even if they are at the top of the source body.

In the summary, use the second sentence to mention one more high-impact item or to characterize the long tail (e.g. "plus dozens of smaller fixes across MCP, vim mode, and terminal rendering").

**Second-clause variety.** When the title_short uses a two-clause "X; Y" smart-brevity structure, prefer pairing items from different priority tiers — e.g. one #1 breaking change with one #2 data-loss fix, or one #2 fix with one #3 feature. Avoid pairing two #4 correctness fixes when a #1 or #2 item is sitting unmentioned in the body.
</priority_order>

<content_fidelity>
Use the body's own words. Describe only behavior the body explicitly states; do not explain how something works, why it was added, or what user benefit it provides unless the body states it.
</content_fidelity>

<banned_phrasing>
Strip these from all three outputs:
- Marketing language: "exciting", "powerful", "seamlessly", "delight", "unlock", "major", "important", "significant".
- Vague categories: "various improvements", "bug fixes", "UI improvements", "UI consistency enhancements", "stability improvements", "internal fixes", "quality improvements".
- Pipeline boilerplate: "manual updates", "manual API updates", "codegen related update", "internal codegen", "format chores", "lint fixes". When the input is mostly these, summarize only what remains.
- Ticket numbers, PR numbers, commit hashes, internal codenames.
</banned_phrasing>

<fallback>
The summary text "${EMPTY_BODY_FALLBACK}" is used only when the body is empty, a single dependency-bump line, or pure pipeline boilerplate with no other content. Even in this case, still produce a meaningful formulaic title and short title — never put the fallback string in the title or title_short.

When the body is a documentation page, blog post, marketing announcement, or any prose describing something concrete, summarize that content using its actual words. Do not refuse just because it is not a code changelog.
</fallback>

<examples>
<example>
<input>Org: openai
Title: v0.10.0
Version: v0.10.0
Body:
### Features
* api: add quantity field to admin org usage responses
* api: launch realtime translate
* api: manual updates
### Bug Fixes
* fix imagegen size enum regression</input>
<good_output>
<title>OpenAI Node SDK v0.10.0 adds quantity field to admin org usage</title>
<title_short>Admin org usage gets quantity field; realtime translate launches</title_short>
<summary>Admin organization usage responses now include a quantity field, and realtime translation is available. Fixed an imagegen size enum regression.</summary>
</good_output>
<bad_output reason="title_short used 'Adds X and Y' instead of leading with the noun and outcome">
<title>OpenAI Node SDK v0.10.0 adds quantity field to admin org usage</title>
<title_short>Adds quantity field and launches realtime translate</title_short>
<summary>Admin organization usage responses now include a quantity field, and realtime translation is available. Fixed an imagegen size enum regression.</summary>
</bad_output>
</example>

<example>
<input>Org: anthropic
Title: 2.1.128
Version: 2.1.128
Body: 35 bullets where #1-#3 are cosmetic ("/color picks random colors", model picker label, --plugin-dir accepts .zip), #15 is "EnterWorktree now creates from local HEAD instead of origin/, no longer dropping unpushed commits", #20 is "Fixed crash loop when piping >10 MB to claude -p via stdin"</input>
<good_output>
<title>Claude Code 2.1.128 fixes worktree bug that dropped unpushed commits</title>
<title_short>Worktree no longer drops unpushed commits</title_short>
<summary>Fixed a worktree bug that was dropping unpushed commits and a crash loop when piping over 10 MB stdin to claude -p. Plus dozens of smaller fixes across MCP, vim mode, and terminal rendering.</summary>
</good_output>
<bad_output reason="title_short led with 'Fixes' verb and described mechanism instead of outcome">
<title>Claude Code 2.1.128 fixes worktree bug that dropped unpushed commits</title>
<title_short>Fixes worktree bug dropping unpushed commits</title_short>
<summary>Fixed a worktree bug that was dropping unpushed commits and a crash loop when piping over 10 MB stdin to claude -p. Plus dozens of smaller fixes across MCP, vim mode, and terminal rendering.</summary>
</bad_output>
</example>

<example>
<input>Org: anthropic
Title: 2.1.129
Version: 2.1.129
Body: 25 bullets. The first 4 are feature additions: "Added --plugin-url flag to fetch a plugin .zip archive from a URL", "Added CLAUDE_CODE_FORCE_SYNC_OUTPUT env var", "Added CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE", "Plugin manifests: themes and monitors should now be declared under experimental". Bullet #5 reads: "Gateway /v1/models discovery for the /model picker is now opt-in via CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 (was automatic in 2.1.126–2.1.128)". Later bullets include: "Fixed OAuth refresh race after wake-from-sleep that could log out all running sessions" and "Fixed 1-hour prompt cache TTL being silently downgraded to 5 minutes".</input>
<good_output>
<title>Claude Code 2.1.129 makes gateway model discovery opt-in and hardens OAuth refresh</title>
<title_short>Gateway model discovery now opt-in; OAuth refresh hardened</title_short>
<summary>Gateway /v1/models discovery for the /model picker is now opt-in via CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1, reverting the automatic behavior introduced in 2.1.126. Fixed an OAuth refresh race after wake-from-sleep that could log out all running sessions, and a 1-hour prompt cache TTL being silently downgraded to 5 minutes.</summary>
</good_output>
<bad_output reason="led with #4 correctness fixes and missed the #1 default-behavior reversal buried at bullet #5; the gateway discovery change breaks users on 2.1.126-128">
<title>Claude Code 2.1.129 fixes prompt cache TTL downgrade and adds plugin URL flag</title>
<title_short>Prompt cache TTL no longer downgrades; OAuth refresh hardened</title_short>
<summary>Fixed a 1-hour prompt cache TTL being silently downgraded to 5 minutes, and an OAuth refresh race after wake-from-sleep. Added --plugin-url flag to fetch plugins from URLs.</summary>
</bad_output>
</example>

<example>
<input>Org: vercel
Title: v15.4.2
Version: v15.4.2
Body: Updated dependencies.</input>
<good_output>
<title>Next.js v15.4.2 dependency update</title>
<title_short>Dependency update</title_short>
<summary>${EMPTY_BODY_FALLBACK}</summary>
</good_output>
</example>

<example>
<input>Org: openai
Title: Building live speech translation with the Realtime API
Body: Shows how to build live speech translation with the Realtime API.</input>
<good_output>
<title>OpenAI publishes guide to building live speech translation with Realtime API</title>
<title_short>Live speech translation guide for Realtime API</title_short>
<summary>New guide covers building live speech translation with the Realtime API.</summary>
</good_output>
<bad_output reason="title_short forced smart-brevity transformation onto guide content; smart brevity does not apply to documentation/announcement releases">
<title>OpenAI publishes guide to building live speech translation with Realtime API</title>
<title_short>Realtime API: live speech translation guide ships</title_short>
<summary>New guide covers building live speech translation with the Realtime API.</summary>
</bad_output>
</example>

<example>
<input>Org: linear
Title: 2026.18 — Various improvements
Version: 2026.18
Body:
This week's release brings exciting quality-of-life improvements across the app:
- Powerful new keyboard shortcuts to seamlessly navigate between projects (delight!)
- UI consistency enhancements throughout the issue detail view
- Various bug fixes and stability improvements
- Internal: codegen related update (PR #4821)
- Sub-issues now inherit the parent's project automatically — previously they stayed unassigned, which surprised teams using project-scoped views.
- Fixed a regression where the Cmd+K palette would crash if the user had >500 favorites.</input>
<good_output>
<title>Linear 2026.18 fixes Cmd+K crash and inherits parent project on sub-issues</title>
<title_short>Cmd+K palette crash fixed; sub-issues inherit parent project</title_short>
<summary>Sub-issues now inherit the parent's project automatically, and a Cmd+K palette crash for users with more than 500 favorites is fixed.</summary>
</good_output>
<bad_output reason="title and title_short kept marketing language and missed the real fixes buried below">
<title>Linear 2026.18 brings exciting quality-of-life improvements</title>
<title_short>Powerful new keyboard shortcuts and bug fixes</title_short>
<summary>Exciting quality-of-life improvements include powerful new keyboard shortcuts and various bug fixes (PR #4821).</summary>
</bad_output>
</example>

<example>
<input>Org: hugging-face
Source: TRL
Title: v1.4.0
Version: v1.4.0
Body: A new \`loss_type="chunked_nll"\` option for SFT drastically reduces peak activation memory by computing cross-entropy over tokens in checkpointed chunks instead of materializing the full \`[batch × seq × vocab]\` logits tensor, unlocking sequence lengths that previously caused out-of-memory errors. Also added OpenReward Standard environment adapter, length-normalized DPO sigmoid loss, training chat templates for Cohere, Cohere2, Gemma 3, Qwen3, and Qwen2.5.</input>
<good_output>
<title>TRL v1.4.0 unlocks longer SFT sequences with chunked cross-entropy loss</title>
<title_short>Chunked cross-entropy unlocks longer SFT sequences</title_short>
<summary>A new loss_type="chunked_nll" option for SFT computes cross-entropy over tokens in checkpointed chunks instead of materializing the full logits tensor, unlocking sequence lengths that previously caused out-of-memory errors. Also added OpenReward Standard environment adapter, length-normalized DPO sigmoid loss, and training chat templates for Cohere, Cohere2, Gemma 3, Qwen3, and Qwen2.5.</summary>
</good_output>
<bad_output reason="title_short led with the mechanism (chunked cross-entropy loss is the *how*) framed as an added option; for capacity/performance releases, the user-facing outcome (longer sequences now fit) is the headline">
<title>TRL v1.4.0 adds chunked cross-entropy loss for SFT memory optimization</title>
<title_short>Chunked NLL loss option added to SFT</title_short>
<summary>A new loss_type="chunked_nll" option for SFT reduces peak activation memory. Also added OpenReward Standard environment adapter, length-normalized DPO sigmoid loss, and training chat templates.</summary>
</bad_output>
</example>
</examples>`;

export interface SummarizeReleaseInput {
  orgSlug: string;
  /** Human-readable label (e.g. "Claude Code"). Used in the headline. */
  sourceName: string;
  /** Set only when the org groups multiple products through one source. */
  productName: string | null;
  title: string;
  version: string | null;
  /** Canonical release URL. `releases.url` is nullable in the schema, so callers may omit it. */
  url: string | null;
  content: string;
}

export interface ReleaseContentUsage {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export interface SummarizeReleaseResult {
  /** All three null when the body was empty — caller skips the write. */
  title: string | null;
  titleShort: string | null;
  summary: string | null;
  usage: ReleaseContentUsage;
  /** True when isEmptyContent short-circuited and no model call was made. */
  skipped: boolean;
}

/**
 * Render the user-message block from a release. Exported for cross-provider
 * evaluations that need the same input shape.
 */
export function buildReleaseBlock(input: SummarizeReleaseInput): string {
  const body =
    input.content.length > MAX_BODY_CHARS
      ? input.content.slice(0, MAX_BODY_CHARS) + "\n\n[truncated]"
      : input.content;

  const productLine =
    input.productName && input.productName !== input.sourceName
      ? `Product: ${input.productName}`
      : null;

  return [
    `Org: ${input.orgSlug}`,
    `Source: ${input.sourceName}`,
    productLine,
    `Title: ${input.title}`,
    input.version ? `Version: ${input.version}` : null,
    input.url ? `URL: ${input.url}` : null,
    "",
    "Body:",
    body,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Pull a single tagged value out of a model response. Returns "" when the tag
 * is missing — callers should treat empty as "field not provided", not as an
 * error condition.
 */
export function extractTagged(text: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const m = text.match(re);
  return (m?.[1] ?? "").trim();
}

/**
 * Pull title / title_short / summary out of a model response. Exported so the
 * batch path (`scripts/generate-release-content.ts`) parses each batch line
 * through the same logic as the live `summarizeRelease` call — byte-for-byte
 * identical on the parsing side.
 *
 * Takes the joined text + stop_reason rather than the SDK's `Message` type so
 * consumers of this module don't drag the full `@anthropic-ai/sdk` namespace
 * through their own typecheck. The workspace has dupe-installs of the SDK
 * (root + workers/api/packages resolve to different `.bun/` hashes for the
 * same 0.95.0 version), and exporting an SDK-namespace type from this file
 * surfaces a `#private`-field nominal mismatch on the `Anthropic` class
 * downstream. Passing a string + nullable string sidesteps it entirely.
 */
export function parseReleaseContent(
  raw: string,
  stopReason: string | null,
): Omit<SummarizeReleaseResult, "skipped" | "usage"> {
  const summary = extractTagged(raw, "summary");
  if (!summary) {
    throw new Error(
      `model output missing or empty <summary> tag (raw length ${raw.length}, stop_reason=${stopReason ?? "unknown"})`,
    );
  }
  return {
    title: extractTagged(raw, "title") || null,
    titleShort: extractTagged(raw, "title_short") || null,
    summary,
  };
}

/**
 * Run a release body through Haiku 4.5 to produce title / short title /
 * summary. Returns all-null + `skipped: true` when the body has no real
 * content (read paths fall back to the raw release.title).
 *
 * Throws when the model returns no `<summary>` tag (output_too_short or
 * upstream API error). Title fields are independent — missing `<title>`
 * or `<title_short>` yields null rather than a fabricated placeholder.
 */
export async function summarizeRelease(
  client: Anthropic,
  input: SummarizeReleaseInput,
): Promise<SummarizeReleaseResult> {
  if (isEmptyContent(input.content)) {
    return {
      title: null,
      titleShort: null,
      summary: null,
      usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
      skipped: true,
    };
  }

  const releaseBlock = buildReleaseBlock(input);
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: releaseBlock }],
  });

  // The Messages API returns an array of typed content blocks. We don't
  // pass tools so the model only ever returns text, but it's not contractual
  // that text sits at index 0 — concatenate every text block defensively.
  const raw = res.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
  return {
    ...parseReleaseContent(raw, res.stop_reason),
    usage: {
      input: res.usage.input_tokens,
      output: res.usage.output_tokens,
      cacheCreate: res.usage.cache_creation_input_tokens ?? 0,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
    },
    skipped: false,
  };
}
