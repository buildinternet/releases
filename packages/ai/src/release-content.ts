/**
 * Generate `title_generated`, `title_short`, and `summary`
 * for a release row via Anthropic Haiku 4.5 + a tuned system prompt.
 *
 * Used by:
 *   - `scripts/generate-release-content.ts` — operational backfill / rerun
 *   - the API worker's poll-fetch / scrape-agent workflows (per-org opt-in)
 *
 * Worker-safe: no `fs`, no `node:*` imports, no logger. Caller constructs the
 * `TextModel` (so the worker can route through AI Gateway / a cheap OpenRouter
 * model when `openrouter-enabled` is on, and the script path can hit the
 * Anthropic API directly).
 */

import type { ReleaseComposition } from "@buildinternet/releases-core/composition";
import { isBreakingLevel, type BreakingLevel } from "@buildinternet/releases-core/breaking";
import { isImportanceScore } from "@buildinternet/releases-core/importance";
import type { TextModel } from "./text-model";

export type { ReleaseComposition };

/** Model id used by the live and batch release-content paths. Exported so the
 *  backfill script can submit identical request shapes through the Batches API. */
export const MODEL = "claude-haiku-4-5";

/** Maximum characters of release body sent to the model (truncated at this length). */
export const MAX_BODY_CHARS = 8000;

/** Cap on the model's response. Sized for ~80-char title + ~70-char short + 1-2 sentence summary
 *  in tagged XML, with headroom for the trailing <composition> count tag (~25-30 tokens for
 *  two-digit counts), plus the <breaking> verdict word + a ≤3-sentence <migration> note (#1696,
 *  ~120 tokens), plus a single-digit <importance> tag (~5 tokens). 440 = 420 (pre-importance
 *  cap) + ~20 buffer. */
export const MAX_OUTPUT_TOKENS = 440;

// In-prompt sentinel emitted by the model when the body is boilerplate-only.
// The empty-body short-circuit (isEmptyContent) is a separate path — those
// rows skip the model entirely and return all-null fields.
export const EMPTY_BODY_FALLBACK = "Release notes do not describe the change.";

// Boilerplate short titles authorized by <title_short_format> rule 8.
const BOILERPLATE_SHORT_TITLES = new Set(["dependency update", "internal release"]);

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
Output exactly one <empty>...</empty> tag, then one <title>...</title> tag, then one <title_short>...</title_short> tag, then one <summary>...</summary> tag, then one <composition>...</composition> tag, then one <breaking>...</breaking> tag, then one <migration>...</migration> tag, then one <importance>...</importance> tag, in that order. Output nothing before, between, or after these tags.

The <empty> tag is a boolean — exactly the literal string \`true\` or \`false\`, with no other text inside the tag. It is true when the body has no real release-note content (see <fallback> below) and false otherwise. When empty is true, downstream discards the summary and short title entirely — still produce a formulaic title from the product and version (e.g. "Next.js v15.4.2 dependency update"), but the summary and title_short content is ignored.

The <breaking> and <migration> tags classify upgrade risk — see <breaking_change> below. You are already scanning the body for breaking changes to write the title and summary (priority #1); the <breaking> tag just records that verdict.

The <importance> tag scores newsworthiness — see <importance_format> below.
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

<composition_format>
After the summary, output an integer count of how many distinct items in the body fall into each of three categories. This is a sanity check on your summary — if the body is 90% bug fixes you should not be leading the summary with a feature.

Categories:

- **bugs** — fixes for crashes, regressions, incorrect behavior, security or data-loss issues. Anything described as "fix", "fixed", "resolves", "no longer", "stops", a crash/freeze/leak being addressed, or a security/CVE patch.
- **features** — new user-facing capabilities, new APIs, new commands, new components, new integrations. Anything described as "add", "added", "new", "introduce", "launch", "ship", "now supports", or the first appearance of a capability.
- **enhancements** — improvements to existing capabilities that are not bug fixes: performance optimizations, expanded options on an existing API, better defaults, improved UX, refactors with observable user benefit, deprecation paths. Anything described as "improve", "improved", "faster", "now also", "expanded", "deprecated".

Rules:

- Count distinct items, not bullet points. One bullet listing three fixes counts as 3 bugs.
- Group related items into one if the body itself groups them ("Various MCP fixes (sandbox, tokens, retry)") — count 1.
- Skip internal/chore items (dependency bumps, CI changes, codegen runs, lint fixes) unless the body has no other items.
- If the body is too vague to itemize ("Various improvements", "Internal release"), output 0/0/0.
- If a body uses headed sections ("### Bug Fixes", "### Features", "### Enhancements"), count items under each section into its matching bucket. Items under "Breaking Changes" or "Deprecations" count as enhancements (the change shape is "modify existing"), not bugs.
- Documentation pages, blog posts, marketing announcements — output 0/0/0 (these aren't itemized changes).

Output format: \`<composition><bugs>N</bugs><features>N</features><enhancements>N</enhancements></composition>\` with N as a non-negative integer. Do not include explanations or other text inside the tag.
</composition_format>

<breaking_change>
After the composition, output a <breaking> verdict — the upgrade risk for a consumer who depends on this thing — and a <migration> tag. This is for an engineer (or an agent) asking "can I take this upgrade safely, and if not, what do I change?"

<breaking> is exactly one of:
- **major** — taking the upgrade WILL break a consumer who changes nothing: removals of public API/CLI/config, renamed or changed signatures, changed return shapes, dropped runtime/platform/dependency support ("drops Node 18", "requires Postgres 14+"), required config or data migrations, and DEFAULT-BEHAVIOR REVERSALS that change output for existing users.
- **minor** — a break affecting only an edge case or narrow surface, OR a deprecation that still works this release (announced/shimmed/warns) but is scheduled for removal. Most consumers upgrade with no change.
- **none** — no breaking changes: additive features, bug fixes, performance, docs that don't alter an existing contract. The common case.
- **unknown** — you genuinely cannot tell: the body is too vague / marketing-only / empty AND the version gives no usable SemVer signal (see below).

Precision over recall: a false major/minor is worse than a false unknown — it makes a reader distrust the signal. When torn, pick the LOWER-risk level you can defend; when the body gives no usable signal at all, output unknown.

Use the SemVer signal — for GitHub/npm packages it is often the clearest indicator:
- A major-version release is the maintainer's deliberate breaking signal: a version that bumps the major (a ≥1.0 package landing on \`X.0.0\` — e.g. \`2.0.0\`, \`3.0.0\`), an explicit \`BREAKING CHANGE:\` note, or a \`!\` conventional-commit marker (\`feat!:\`). Lean major even when the prose is thin.
- A patch release (\`x.y.Z\` with Z>0, e.g. \`15.4.2\`) signals no breaking changes under SemVer — lean none unless the body explicitly states a break.
- Pre-1.0 (\`0.y.z\`) does NOT guarantee stability — a 0.x minor bump can break, so judge from the body.
- The body still wins when explicit: a PATCH that reverses a default behavior or removes something is still major (maintainers don't always follow SemVer). And a large version number with purely additive notes is NOT automatically major — don't cry wolf on a routine feature/minor release.

<migration>: if — and ONLY if — the body explicitly describes how to upgrade (a Migration/Upgrading/Breaking-changes section, before→after code, "replace X with Y", "set flag Z"), distill those steps into 1–3 plain sentences using the body's own instructions. Otherwise (a break with no stated steps, or no break) output the literal \`none\`. Never invent steps.

Examples: a release removing \`completions.create\` and dropping Node 18 → \`<breaking>major</breaking>\` with migration steps; a package landing on \`3.0.0\` with only terse notes → \`<breaking>major</breaking>\` (the major-version bump is the maintainer's signal); a \`1.4.2\` patch with only bug fixes → \`<breaking>none</breaking><migration>none</migration>\`; a release deprecating a prop that still works → \`<breaking>minor</breaking><migration>none</migration>\`; a release of only feature additions + bug fixes → \`<breaking>none</breaking><migration>none</migration>\`; a marketing-only "we shipped improvements" body with no version → \`<breaking>unknown</breaking><migration>none</migration>\`.
</breaking_change>

<importance_format>
After the migration note, output a single digit 1-5 scoring how newsworthy this release is — how much attention it deserves relative to everything else in a changelog feed, not how well-written the notes are.

- **5 — landmark:** significant beyond this company's own users — a major model or product launch, GA of a flagship, industry-notable news.
- **4 — major for this company:** a flagship feature, a significant pricing change, or a breaking change most of this product's users will care about.
- **3 — notable:** a real feature or a meaningful improvement worth a user's attention.
- **2 — routine:** minor enhancements, small fix rollups, incremental updates.
- **1 — housekeeping:** patch releases, dependency bumps, docs/typo fixes, internal chores.

Judge from the content itself, not the title's framing or the version number's SemVer position alone. When torn between two adjacent levels, pick the lower one — precision over recall applies here the same way it does to <breaking>. Boilerplate or empty releases (empty is true) always get 1.

Output format: \`<importance>N</importance>\` with N a single digit 1-5. No other text inside the tag.
</importance_format>

<fallback>
Set <empty>true</empty> only when the body is empty, a single dependency-bump line, or pure pipeline boilerplate with no other content. When empty is true, write the fallback summary "${EMPTY_BODY_FALLBACK}" and use "Dependency update" or "Internal release" for title_short — downstream will discard both fields, so their exact text only matters as a sanity signal. The title field is kept regardless, so always produce a formulaic title from product + version (e.g. "Next.js v15.4.2 dependency update").

Set <empty>false</empty> in all other cases, including documentation pages, blog posts, and marketing announcements. Summarize that content using its actual words — do not refuse just because it is not a code changelog.
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
<empty>false</empty>
<title>OpenAI Node SDK v0.10.0 adds quantity field to admin org usage</title>
<title_short>Admin org usage gets quantity field; realtime translate launches</title_short>
<summary>Admin organization usage responses now include a quantity field, and realtime translation is available. Fixed an imagegen size enum regression.</summary>
<composition><bugs>1</bugs><features>2</features><enhancements>0</enhancements></composition>
<breaking>none</breaking>
<migration>none</migration>
<importance>3</importance>
</good_output>
<bad_output reason="title_short used 'Adds X and Y' instead of leading with the noun and outcome">
<empty>false</empty>
<title>OpenAI Node SDK v0.10.0 adds quantity field to admin org usage</title>
<title_short>Adds quantity field and launches realtime translate</title_short>
<summary>Admin organization usage responses now include a quantity field, and realtime translation is available. Fixed an imagegen size enum regression.</summary>
<composition><bugs>1</bugs><features>2</features><enhancements>0</enhancements></composition>
<breaking>none</breaking>
<migration>none</migration>
<importance>3</importance>
</bad_output>
</example>

<example>
<input>Org: anthropic
Title: 2.1.128
Version: 2.1.128
Body: 35 bullets where #1-#3 are cosmetic ("/color picks random colors", model picker label, --plugin-dir accepts .zip), #15 is "EnterWorktree now creates from local HEAD instead of origin/, no longer dropping unpushed commits", #20 is "Fixed crash loop when piping >10 MB to claude -p via stdin"</input>
<good_output>
<empty>false</empty>
<title>Claude Code 2.1.128 fixes worktree bug that dropped unpushed commits</title>
<title_short>Worktree no longer drops unpushed commits</title_short>
<summary>Fixed a worktree bug that was dropping unpushed commits and a crash loop when piping over 10 MB stdin to claude -p. Plus dozens of smaller fixes across MCP, vim mode, and terminal rendering.</summary>
<composition><bugs>20</bugs><features>0</features><enhancements>3</enhancements></composition>
<breaking>none</breaking>
<migration>none</migration>
<importance>2</importance>
</good_output>
<bad_output reason="title_short led with 'Fixes' verb and described mechanism instead of outcome">
<empty>false</empty>
<title>Claude Code 2.1.128 fixes worktree bug that dropped unpushed commits</title>
<title_short>Fixes worktree bug dropping unpushed commits</title_short>
<summary>Fixed a worktree bug that was dropping unpushed commits and a crash loop when piping over 10 MB stdin to claude -p. Plus dozens of smaller fixes across MCP, vim mode, and terminal rendering.</summary>
<composition><bugs>20</bugs><features>0</features><enhancements>3</enhancements></composition>
<breaking>none</breaking>
<migration>none</migration>
<importance>2</importance>
</bad_output>
</example>

<example>
<input>Org: anthropic
Title: 2.1.129
Version: 2.1.129
Body: 25 bullets. The first 4 are feature additions: "Added --plugin-url flag to fetch a plugin .zip archive from a URL", "Added CLAUDE_CODE_FORCE_SYNC_OUTPUT env var", "Added CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE", "Plugin manifests: themes and monitors should now be declared under experimental". Bullet #5 reads: "Gateway /v1/models discovery for the /model picker is now opt-in via CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 (was automatic in 2.1.126–2.1.128)". Later bullets include: "Fixed OAuth refresh race after wake-from-sleep that could log out all running sessions" and "Fixed 1-hour prompt cache TTL being silently downgraded to 5 minutes".</input>
<good_output>
<empty>false</empty>
<title>Claude Code 2.1.129 makes gateway model discovery opt-in and hardens OAuth refresh</title>
<title_short>Gateway model discovery now opt-in; OAuth refresh hardened</title_short>
<summary>Gateway /v1/models discovery for the /model picker is now opt-in via CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1, reverting the automatic behavior introduced in 2.1.126. Fixed an OAuth refresh race after wake-from-sleep that could log out all running sessions, and a 1-hour prompt cache TTL being silently downgraded to 5 minutes.</summary>
<composition><bugs>15</bugs><features>4</features><enhancements>2</enhancements></composition>
<breaking>major</breaking>
<migration>Set CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 to restore the automatic gateway /v1/models discovery this release made opt-in.</migration>
<importance>4</importance>
</good_output>
<bad_output reason="led with #4 correctness fixes and missed the #1 default-behavior reversal buried at bullet #5; the gateway discovery change breaks users on 2.1.126-128">
<empty>false</empty>
<title>Claude Code 2.1.129 fixes prompt cache TTL downgrade and adds plugin URL flag</title>
<title_short>Prompt cache TTL no longer downgrades; OAuth refresh hardened</title_short>
<summary>Fixed a 1-hour prompt cache TTL being silently downgraded to 5 minutes, and an OAuth refresh race after wake-from-sleep. Added --plugin-url flag to fetch plugins from URLs.</summary>
<composition><bugs>15</bugs><features>4</features><enhancements>2</enhancements></composition>
<breaking>major</breaking>
<migration>Set CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 to restore the automatic gateway /v1/models discovery this release made opt-in.</migration>
<importance>4</importance>
</bad_output>
</example>

<example>
<input>Org: vercel
Title: v15.4.2
Version: v15.4.2
Body: Updated dependencies.</input>
<good_output>
<empty>true</empty>
<title>Next.js v15.4.2 dependency update</title>
<title_short>Dependency update</title_short>
<summary>${EMPTY_BODY_FALLBACK}</summary>
<composition><bugs>0</bugs><features>0</features><enhancements>0</enhancements></composition>
<breaking>none</breaking>
<migration>none</migration>
<importance>1</importance>
</good_output>
</example>

<example>
<input>Org: openai
Title: Building live speech translation with the Realtime API
Body: Shows how to build live speech translation with the Realtime API.</input>
<good_output>
<empty>false</empty>
<title>OpenAI publishes guide to building live speech translation with Realtime API</title>
<title_short>Live speech translation guide for Realtime API</title_short>
<summary>New guide covers building live speech translation with the Realtime API.</summary>
<composition><bugs>0</bugs><features>0</features><enhancements>0</enhancements></composition>
<breaking>none</breaking>
<migration>none</migration>
<importance>2</importance>
</good_output>
<bad_output reason="title_short forced smart-brevity transformation onto guide content; smart brevity does not apply to documentation/announcement releases">
<empty>false</empty>
<title>OpenAI publishes guide to building live speech translation with Realtime API</title>
<title_short>Realtime API: live speech translation guide ships</title_short>
<summary>New guide covers building live speech translation with the Realtime API.</summary>
<composition><bugs>0</bugs><features>0</features><enhancements>0</enhancements></composition>
<breaking>none</breaking>
<migration>none</migration>
<importance>2</importance>
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
<empty>false</empty>
<title>Linear 2026.18 fixes Cmd+K crash and inherits parent project on sub-issues</title>
<title_short>Cmd+K palette crash fixed; sub-issues inherit parent project</title_short>
<summary>Sub-issues now inherit the parent's project automatically, and a Cmd+K palette crash for users with more than 500 favorites is fixed.</summary>
<composition><bugs>1</bugs><features>1</features><enhancements>2</enhancements></composition>
<breaking>none</breaking>
<migration>none</migration>
<importance>3</importance>
</good_output>
<bad_output reason="title and title_short kept marketing language and missed the real fixes buried below">
<empty>false</empty>
<title>Linear 2026.18 brings exciting quality-of-life improvements</title>
<title_short>Powerful new keyboard shortcuts and bug fixes</title_short>
<summary>Exciting quality-of-life improvements include powerful new keyboard shortcuts and various bug fixes (PR #4821).</summary>
<composition><bugs>1</bugs><features>1</features><enhancements>2</enhancements></composition>
<breaking>none</breaking>
<migration>none</migration>
<importance>3</importance>
</bad_output>
</example>

<example>
<input>Org: hugging-face
Source: TRL
Title: v1.4.0
Version: v1.4.0
Body: A new \`loss_type="chunked_nll"\` option for SFT drastically reduces peak activation memory by computing cross-entropy over tokens in checkpointed chunks instead of materializing the full \`[batch × seq × vocab]\` logits tensor, unlocking sequence lengths that previously caused out-of-memory errors. Also added OpenReward Standard environment adapter, length-normalized DPO sigmoid loss, training chat templates for Cohere, Cohere2, Gemma 3, Qwen3, and Qwen2.5.</input>
<good_output>
<empty>false</empty>
<title>TRL v1.4.0 unlocks longer SFT sequences with chunked cross-entropy loss</title>
<title_short>Chunked cross-entropy unlocks longer SFT sequences</title_short>
<summary>A new loss_type="chunked_nll" option for SFT computes cross-entropy over tokens in checkpointed chunks instead of materializing the full logits tensor, unlocking sequence lengths that previously caused out-of-memory errors. Also added OpenReward Standard environment adapter, length-normalized DPO sigmoid loss, and training chat templates for Cohere, Cohere2, Gemma 3, Qwen3, and Qwen2.5.</summary>
<composition><bugs>0</bugs><features>4</features><enhancements>0</enhancements></composition>
<breaking>none</breaking>
<migration>none</migration>
<importance>3</importance>
</good_output>
<bad_output reason="title_short led with the mechanism (chunked cross-entropy loss is the *how*) framed as an added option; for capacity/performance releases, the user-facing outcome (longer sequences now fit) is the headline">
<empty>false</empty>
<title>TRL v1.4.0 adds chunked cross-entropy loss for SFT memory optimization</title>
<title_short>Chunked NLL loss option added to SFT</title_short>
<summary>A new loss_type="chunked_nll" option for SFT reduces peak activation memory. Also added OpenReward Standard environment adapter, length-normalized DPO sigmoid loss, and training chat templates.</summary>
<composition><bugs>0</bugs><features>4</features><enhancements>0</enhancements></composition>
<breaking>none</breaking>
<migration>none</migration>
<importance>3</importance>
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
  /** All four null when the body was empty — caller skips the write. */
  title: string | null;
  titleShort: string | null;
  summary: string | null;
  composition: ReleaseComposition | null;
  /**
   * Breaking-change verdict (#1696), produced by the same call. Always present
   * (`"unknown"` on empty body, parse miss, or genuine uncertainty — fail-open).
   * The caller decides whether to PERSIST it (gated to developer-facing source
   * kinds); the model classifies regardless of kind.
   */
  breaking: BreakingLevel;
  /** Explicit upgrade/migration steps lifted from the body (#1696); null when none. */
  migrationNotes: string | null;
  /**
   * AI-scored newsworthiness, 1 (housekeeping) to 5 (landmark). Fail-open:
   * null when the tag is absent, non-integer, or out of range (parse miss,
   * older cached prompt, truncated output) — never a fabricated score. Also
   * null on a skipped (empty-body) call, since no model call was made.
   */
  importance: number | null;
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
 * Pull the nested <composition><bugs>N</bugs>… block out of a model response
 * and parse the three integer counts. Returns `null` when:
 *
 *   - the <composition> tag is absent (older response, output truncated),
 *   - any sub-tag is missing,
 *   - any sub-value fails to parse as a non-negative finite integer,
 *   - all three counts are zero (boilerplate / docs / empty-body case — we
 *     don't store an all-zero shape because it's noise on the wire and the
 *     UI can't say anything useful from it).
 *
 * Exported so the batch path and any future provider eval parses identically.
 */
export function parseComposition(raw: string): ReleaseComposition | null {
  const block = extractTagged(raw, "composition");
  if (!block) return null;
  const bugs = parseCount(block, "bugs");
  const features = parseCount(block, "features");
  const enhancements = parseCount(block, "enhancements");
  if (bugs === null || features === null || enhancements === null) return null;
  if (bugs === 0 && features === 0 && enhancements === 0) return null;
  return { bugs, features, enhancements };
}

function parseCount(block: string, tag: string): number | null {
  const inner = extractTagged(block, tag);
  if (!inner) return null;
  const n = Number(inner);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * Pull title / title_short / summary / composition out of a model response.
 * Exported so the batch path (`scripts/generate-release-content.ts`) parses
 * each batch line through the same logic as the live `summarizeRelease` call
 * — byte-for-byte identical on the parsing side.
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
  const titleShort = extractTagged(raw, "title_short") || null;

  // <empty>true</empty> is the primary boilerplate signal — when present, we
  // discard summary + title_short regardless of their text.
  //
  // The fallback SUMMARY sentinel ("Release notes do not describe the change.")
  // is reserved: the prompt only ever instructs the model to emit it for empty
  // bodies, so it is never a legitimate summary. Treat it as a discard signal
  // unconditionally — the model sometimes emits <empty>false</empty> while still
  // writing the sentinel (a self-contradiction). Trusting the tag there leaked
  // the sentinel into the stored summary and rendered it on the release page.
  //
  // A boilerplate SHORT TITLE ("Dependency update") CAN be a legitimate headline,
  // so it only counts as a discard signal when the <empty> tag is absent (older
  // cached prompt / truncated output) and there's no structured verdict to trust.
  const emptyTag = readEmptyTag(raw);
  const isFallbackSummary = summary.trim().toLowerCase() === EMPTY_BODY_FALLBACK.toLowerCase();
  const isFallbackShort =
    titleShort !== null && BOILERPLATE_SHORT_TITLES.has(titleShort.trim().toLowerCase());
  const discard =
    emptyTag === "true" || isFallbackSummary || (emptyTag === null && isFallbackShort);

  const { breaking, migrationNotes } = parseBreaking(raw);

  return {
    title: extractTagged(raw, "title") || null,
    titleShort: discard ? null : titleShort,
    summary: discard ? null : summary,
    composition: parseComposition(raw),
    breaking,
    migrationNotes,
    importance: parseImportance(raw),
  };
}

/**
 * Pull the `<importance>` score out of a model response. Fail-open: an
 * absent tag, a non-integer value, or a value outside 1-5 all map to `null`
 * (never a fabricated score, and never throws) — the same posture as
 * `parseBreaking`'s "unknown". Exported so the batch path parses identically.
 */
export function parseImportance(raw: string): number | null {
  const tag = extractTagged(raw, "importance").trim();
  if (!tag) return null;
  const n = Number(tag);
  return isImportanceScore(n) ? n : null;
}

function readEmptyTag(raw: string): "true" | "false" | null {
  const v = extractTagged(raw, "empty").trim().toLowerCase();
  if (v === "true") return "true";
  if (v === "false") return "false";
  return null;
}

/** Migration-note sentinels the model emits when there are no explicit upgrade steps. */
const NO_MIGRATION = new Set(["", "none", "n/a", "na", "null"]);

/**
 * Pull the `<breaking>` verdict + `<migration>` note out of a model response
 * (#1696). Fail-open: an absent or unrecognized `<breaking>` value maps to
 * `"unknown"` (the safe verdict, never an exception — `unknown` is itself a
 * valid level). `migrationNotes` is null unless the model returned real upgrade
 * steps. Exported so the batch path parses identically. Note that this leaves
 * the PERSIST decision (gating to developer-facing source kinds) to the caller —
 * here we only surface what the model said.
 */
export function parseBreaking(raw: string): {
  breaking: BreakingLevel;
  migrationNotes: string | null;
} {
  const verdict = extractTagged(raw, "breaking").toLowerCase();
  const breaking: BreakingLevel = isBreakingLevel(verdict) ? verdict : "unknown";
  if (breaking === "none" || breaking === "unknown") {
    return { breaking, migrationNotes: null };
  }
  const note = extractTagged(raw, "migration").trim();
  return { breaking, migrationNotes: NO_MIGRATION.has(note.toLowerCase()) ? null : note };
}

/**
 * Run a release body through the supplied `TextModel` to produce title / short
 * title / summary. The caller constructs the model (Anthropic Haiku via AI
 * Gateway, or a cheap OpenRouter model when `openrouter-enabled` is on), so this
 * helper stays provider-neutral. Returns all-null + `skipped: true`
 * when the body has no real content (read paths fall back to the raw
 * release.title).
 *
 * Throws when the model returns no `<summary>` tag (output_too_short or
 * upstream API error). Title fields are independent — missing `<title>`
 * or `<title_short>` yields null rather than a fabricated placeholder.
 */
export async function summarizeRelease(
  model: TextModel,
  input: SummarizeReleaseInput,
): Promise<SummarizeReleaseResult> {
  if (isEmptyContent(input.content)) {
    return {
      title: null,
      titleShort: null,
      summary: null,
      composition: null,
      // No model call → no breaking verdict. Stays "unknown" (fail-open).
      breaking: "unknown",
      migrationNotes: null,
      // No model call → no importance score.
      importance: null,
      usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
      skipped: true,
    };
  }

  const releaseBlock = buildReleaseBlock(input);
  // `cacheSystem` honors Anthropic prompt caching on the large system prompt;
  // the OpenRouter adapter ignores it (no cross-call caching on that lane).
  // The seam returns joined text + usage, so the SDK content-block walk and
  // stop_reason plumbing live inside the adapter, not here. parseReleaseContent
  // only uses stop_reason for an error message, so passing null is harmless.
  const { text: raw, usage } = await model.complete({
    system: SYSTEM_PROMPT,
    user: releaseBlock,
    maxTokens: MAX_OUTPUT_TOKENS,
    cacheSystem: true,
  });

  return {
    ...parseReleaseContent(raw, null),
    usage: {
      input: usage.input,
      output: usage.output,
      cacheCreate: usage.cacheCreate,
      cacheRead: usage.cacheRead,
    },
    skipped: false,
  };
}
