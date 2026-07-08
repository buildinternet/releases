# @releases/ai-internal

AI helpers for the Releases ingest and content pipelines — source evaluation, extraction, classification, and content generation. Worker-safe; the caller supplies the Anthropic client.

## Exports

Imported as `@releases/ai-internal/<subpath>`.

| Subpath                | Purpose                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `evaluate`             | URL evaluation for source onboarding + `buildMetadataFromEvaluation` to seed `SourceMetadata`.      |
| `providers`            | Provider-detection table and hints (feed paths, crawl patterns, preferred source type).             |
| `article-extract`      | Single-article extraction — one page's markdown into clean verbatim body content (feed enrichment). |
| `marketing-classifier` | Haiku 4.5 verdict on whether a feed item is a real release or a marketing post.                     |
| `release-content`      | Generates `title_generated` / `title_short` / `summary` for a release row.                          |
| `collection-summary`   | Generates a collection's daily rollup (headline, summary, bullet takeaways).                        |
| `overview-content`     | Builds the Anthropic request shape for an org overview, with inline source citations.               |
| `overview-citations`   | Resolves an overview model's `{ url }` citations into deduped stored rows.                          |
| `playbook`             | Deterministic playbook markdown generator (auto header + agent-editable notes).                     |
| `grader-prompt`        | Builds the rubric-grading prompt the local grader subagent uses to score an artifact.               |
| `batch`                | Anthropic Message Batches API helpers (submit/poll/collect).                                        |
| `openrouter-client`    | Worker-safe transport to OpenRouter's OpenAI-compatible chat-completions API.                       |
| `aisdk-text-model`     | Wraps an AI SDK `LanguageModel` as a `TextModel` via `generateText` — worker cheap-lane path.       |
| `text-model`           | `TextModel` interface + legacy `anthropicTextModel` / `openRouterTextModel` (scripts/evals).        |

**Private, workspace-only — not published to npm.**
