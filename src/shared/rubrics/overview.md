# Org Overview Rubric

Grades the body of an org overview produced by the `regenerating-overviews` skill (or a managed-agents flow attached to the same task). The skill is the canonical guide for the agent doing the work; this rubric is the parallel artifact for the grader. They overlap in spirit but exist for different readers.

The artifact is the overview body — markdown only, no surrounding metadata. When the grader is given input release blocks alongside the body, faithfulness and weighting criteria are checkable against the inputs; otherwise they're checkable against obvious tells in the body itself.

## Format

- Body has NO markdown headings (no `#`, `##`, `###`, etc., anywhere in the body). The UI renders the org name and section structure; a leading title or any heading inside the body is a fail.
- Body does NOT lead with a duplicated title (a line that is just the org name) or a generic positioning statement (e.g. "X is a leading platform for Y"). Possessive subjects in normal sentence prose are fine when the sentence pivots immediately into concrete shipped information — `Linear's current focus is the full deployment loop — Linear Releases shipped in late April…` passes; `Linear is a project-management platform.` fails.
- Each primary themed section uses one of these two shapes:
  1. **Bold tease** + tight bullet list of concrete items.
  2. **Bold tease** + one to two short prose sentences (each ≤25 words).
     Sections with three or more concrete items should bullet, not prose. A **prose sentence** that lists four or more comma-separated items is a fail — convert to bullets. A bullet that itself names a small set of items (e.g. "Tool X works with A, B, C, and D") is fine; the rule targets dense prose lists, not enumerations inside bullets. A short final wrap-up paragraph without a bold lead is acceptable when it (a) preserves still-current background context the agent is amending into, or (b) batches small additions not worth a primary section. The wrap-up cannot be filler ("continues to evolve…") and cannot be the only paragraph.
- Bullets carry concrete items only. Transition or summary bullets ("Other improvements followed") are a fail.
- Word count is between 80 and 300 words. **Count the words and state the count in `evidence`.** The 120–250 range is the sweet spot. Less than 80 or more than 300 is a fail.
- Past tense, active voice **when describing ship events**. "shipped", "added", "removed", "deprecated" pass. Present tense is fine when describing what a shipped feature does ("the new endpoint accepts JSON", "the agent caches state"). What fails: progressive forms about the org's activity ("is shipping", "has been improving") and weasel passives about the changes themselves ("received improvements").

## Content

- Opens with one concrete sentence on the org's current focus or recent ship, ≤25 words. "Recently shipped X and Y" passes; "X's current focus is Y" passes when Y is a specific shipped area or product and the same sentence delivers concrete information; "Continues to evolve their platform" fails.
- Body has two to five primary themed sections, each with a bold tease. One-section overviews pass only when the source material is genuinely thin (see faithfulness — short bodies are preferred to padded ones). A trailing wrap-up paragraph (per the Format rules above) does not count toward the section limit.
- When multiple sources contribute, sections synthesize by topic across sources rather than summarizing each source separately. A section that reads as a per-source recap is a fail.
- Breaking changes and deprecations are called out inline where they fall, not buried.
- No filler phrases like "continues to evolve", "received improvements", "substantial updates", "robust enhancements", or "exciting new features".
- No restated context the reader already has (project name in body, source count, generic description of what the org does).

## Voice (release notes, not changelog)

- Each section describes a user-visible capability before its implementation. "Agents can drive a real browser session with natural language" leads; "the `/interact` endpoint accepts `prompt` and `actions[]`" supports. The bold tease is the user-facing claim; supporting prose or bullets carry the implementation detail.
- Pure changelog phrasing as the section headline is a fail: endpoint names, parameter names, internal class names, or version numbers as the _headline noun_ are flags. `**Rust FFI v0.12.53 introduced a breaking VideoFrame API change**` fails; `**LiveKit's Rust frame pipeline added per-frame metadata (breaking)**` passes.
- Code, package names, and versions remain useful in supporting prose. The test is whether a reader who doesn't already use the product would learn what shipped from the section lead alone.

## Weighting (the right things lead)

- When the input releases include both product-blog content and SDK / library / repo releases, primary themed sections lead with the product-blog content. SDK and library version bumps consolidate into one wrap-up sentence or a short final bullet group. Three SDK bumps as three primary sections is a fail.
- **Library-shape carve-out.** When the org's primary product is itself a library, SDK, or developer tool (no higher-level product layer above it — e.g. Prisma, pnpm, Bun, Deno's runtime), library releases ARE the user-facing news. The "consolidate to wrap-up" rule above does not apply; the rest of the rubric still does. The grader should infer org shape from the overall mix of inputs (or prior knowledge when inputs aren't supplied).
- Multi-product orgs with five or more active product surfaces (e.g. Vercel: AI Gateway, Flags, Next.js, Turborepo, AI SDK, platform; Cloudflare: Workers, Durable Objects, R2, Zero Trust, AI Search) must weight by user impact. The biggest user-facing story leads. A flagship GA and a minor tooling change cannot occupy equal section weight; smaller surfaces consolidate.
- Routine CVE patches consolidate into a single mention. A named-and-numbered vulnerability gets its own sentence or bullet only when it affects a meaningful share of users. `**CVE-2026-XXXX patched in v1.2.3**` as a primary section is a fail unless the impact warrants it.

## Faithfulness

- No confabulation. Version numbers, feature names, package names, and URLs in the body must be specific and grounded. Vague hand-waves ("the latest v3.x release", "the new SDK", "improved performance across the board") are fails — they read as filler that wasn't in any release.
- When the source material is thin, the body is shorter rather than padded. Omission is preferred to confabulation. A 90-word body grounded in a few real releases beats a 220-word body with invented framing.
- No invented URLs. Markdown links should reference URLs that look plausibly real (vendor domains, repo paths, version anchors) — gibberish slugs or made-up paths are a fail.
- When input release blocks are provided to the grader, every concrete claim in the body must map to an item in the inputs. When inputs are not provided, this criterion passes by default; confabulation tells (above) catch the obvious cases.

## Output discipline

- Media items (markdown images or video links) total at most two. Three or more is a fail.
- Media uses standard markdown — `![alt](url)` for images, `[title](url)` for videos. Raw URLs pasted as text fail.
- The body does not end with a generic closing line ("Stay tuned for more!", "More to come."). The last sentence should land on a concrete change, not a sign-off.
