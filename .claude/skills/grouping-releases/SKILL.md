---
name: grouping-releases
description: >
  Group releases that cover the same underlying launch so readers see one
  story instead of three. Use when parsing a new release (inline) or when
  reconciling an organization's recent releases (batch). Decide which item
  is the best entry point for the average reader and mark it canonical.
---

# Grouping Releases

## What this is for

Releases enter the index from **sources** — individual URLs we track for an organization. One org typically has several sources: a product changelog, a news page, an engineering blog, a GitHub repo. When a big launch happens, it's common for multiple sources to cover the same event. A model launch might show up on a marketing post, a platform changelog, _and_ an app-level version note — three releases, one story.

That overlap is signal, not a bug. Readers want the clearest explanation first, with the corroborating entries attached as supporting coverage. This skill decides which releases belong together and which one leads.

## When this skill runs

- **Inline with parsing.** When the parse flow creates a new release, it hands you a short candidate list (similar recent releases from the same org across all its sources) and asks whether the new item covers any of them.
- **Batch reconciliation.** When an org is being re-checked, you get a window of its recent releases and decide the full grouping.

Either way, you're given the candidate set. Do not go looking for more.

## The rubric

Pick as canonical the release that best answers **"what is this and why should I care?"** for someone who hasn't been following the org. That's usually — but not always — a blog or news post for launches, and the changelog entry for routine updates.

Don't bias by source type. The changelog isn't automatically more authoritative than the news post, and the news post isn't automatically more polished. Read what's there and decide.

## When to group

Releases from the same org that cover **the same underlying event**, published within a few days of each other, where a reader would reasonably want to land on one primary item rather than multiple parallel ones.

## When NOT to group

- Different launches that happen to land the same day (a model release and a pricing change are two separate stories).
- Follow-ups that add substantive new information days or weeks later (standalone — don't bury them under the original).
- App or SDK version bumps that mention the launch but aren't a new launch themselves — these can be coverage if they're the _mechanism_ by which users get the feature, but if they're mostly unrelated changelog bullets, keep them standalone.
- Posts that are _about_ a previously-launched product but aren't themselves a launch. If one of these got parsed as a release, flag it instead of grouping.

## Examples

**Group — marketing post canonical**

- `rel_a` — "Introducing Claude Opus 4.7" (anthropic-news, Apr 16) — full launch post with positioning
- `rel_b` — "Claude Opus 4.7 released" (claude-platform, Apr 16) — API changelog entry with migration notes
- `rel_c` — "Claude Opus 4.7 launch" (claude, Apr 16) — support-site note

Canonical: `rel_a`. A new reader lands on the announcement, sees what it is and why, and can follow links for the technical detail. The changelog entries are coverage — valuable for developers who need the pricing and migration specifics, but not the first thing to read.

**Group — changelog canonical, singleton**

- `rel_d` — "Claude Code 2.1.108" (claude-code, Apr 14) — adds `ENABLE_PROMPT_CACHING_1H` env var

Canonical: `rel_d`, cluster of one. Routine release, changelog is the only entry point and the correct one. No coverage to attach.

**Group — follow-up patch, changelog canonical**

- `rel_j` — "Claude Code 2.1.111" (claude-code, Apr 16) — introduces `xhigh` effort level and auto mode for Opus 4.7
- `rel_k` — "Claude Code 2.1.112" (claude-code, Apr 16) — fixes "claude-opus-4-7 temporarily unavailable" bug in auto mode

Canonical: `rel_j`. 2.1.111 is the feature release; 2.1.112 is a hotfix for a bug introduced by it. Group them — the reader wants to land on the feature, with the fix attached as a corrective follow-up. Note: do **not** roll this pair into a bigger "Opus 4.7 launch" cluster alongside the marketing post. These are Claude Code's own feature work (the `xhigh` level, interactive `/effort` slider, auto mode for Max subscribers are all Claude Code changes, not the model launch itself). The model launch cluster and the Claude Code feature cluster are distinct stories that happen to share a shipping day.

**Don't group — adjacent but distinct**

- `rel_e` — "Claude Cowork generally available" (claude-platform, Apr 9)
- `rel_f` — "Advisor tool launched in public beta" (claude-platform, Apr 9)
- `rel_g` — "Role-based access controls for Enterprise" (claude-platform, Apr 9)

All three landed the same day on the same source. Tempting to merge. Don't — they're distinct capabilities with distinct audiences. Three standalone clusters.

**Don't group — same family, different events**

- `rel_h` — "Introducing Anthropic Labs" (anthropic-news, Apr 10)
- `rel_i` — "Introducing Claude Design by Anthropic Labs" (anthropic-news, Apr 17)

Same product family, a week apart. The later post is a _new_ launch under the Labs umbrella, not coverage of the first announcement.

## What to output

For each grouping you make, return the canonical release ID and a (possibly empty) list of coverage release IDs. Include a one-line reason per cluster — the reconciliation pass uses that to decide whether to revisit your call. If you aren't sure between two plausible canonicals, pick one and say so; a later pass will confirm.

Singletons are fine. It is correct — and common — for a release to be its own cluster of one.

**Every input ID must appear in exactly one cluster in your output — as either a canonical or a coverage item, never both, never neither.** If you think a release is out of scope for the candidate set, still return it as a singleton with a reason explaining why.
