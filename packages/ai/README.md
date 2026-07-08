# @releases/ai-internal

`evaluate` (URL recommendation + `buildMetadataFromEvaluation`), `playbook` (deterministic markdown generation), `providers` (provider-detection table), `release-content` (Haiku 4.5 summarization), and `marketing-classifier` (Haiku 4.5 marketing-vs-release verdict); worker-safe, caller passes the Anthropic client.

## Exports

- `@releases/ai-internal/batch` — helpers for the Anthropic Message Batches API (submit/poll/collect, 50% discount for tolerant call sites).
- `@releases/ai-internal/evaluate` — URL evaluation for source onboarding + `buildMetadataFromEvaluation` to seed `SourceMetadata` from the result.
- `@releases/ai-internal/grader-prompt` — builds the rubric-grading prompt used by the local grader subagent to score an artifact.
- `@releases/ai-internal/article-extract` — single-article extraction: turns one page's markdown into clean verbatim body content (feed-enrichment path).
- `@releases/ai-internal/marketing-classifier` — Haiku 4.5 binary verdict on whether a feed item is a real release or a marketing post.
- `@releases/ai-internal/openrouter-client` — worker-safe transport to OpenRouter's OpenAI-compatible chat-completions API.
- `@releases/ai-internal/playbook` — deterministic playbook markdown generator (auto header + agent-editable notes).
- `@releases/ai-internal/providers` — provider-detection table and hints (feed paths, crawl patterns, preferred source type).
- `@releases/ai-internal/collection-summary` — generates a collection's daily rollup (headline, one-line summary, bullet takeaways).
- `@releases/ai-internal/release-content` — generates `title_generated`/`title_short`/`summary` for a release row.
- `@releases/ai-internal/overview-content` — builds the Anthropic request shape for an org overview, with inline source citations.
- `@releases/ai-internal/overview-citations` — resolves an overview model's `{ url }` citations into deduped stored citation rows.
- `@releases/ai-internal/text-model` — provider-agnostic text-completion seam (`TextModel`) with Anthropic and OpenRouter adapters.

**Private, workspace-only — imported via `@releases/ai-internal`, not published to npm.**
