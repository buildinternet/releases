# Parsing Changelogs

> This skill is a stub. It will replace the heuristic parsing pipeline
> (content-start detection, chunking, incremental parsing) with
> agent-driven extraction guidelines.

## Intended Scope

Given changelog content in any format (rendered HTML, raw markdown, feed entries), extract structured release data: version, title, date, content summary, and breaking change flags.

## What This Will Cover

- Reading a changelog page and identifying where releases begin and end
- Handling different structures: version headings, date sections, flat lists
- Extracting release metadata (version numbers, dates) from varied formats
- Summarizing release content concisely
- Knowing when content is incomplete and more needs to be fetched

## Current Implementation

The existing parsing pipeline in `src/ai/ingest.ts` and `src/ai/incremental.ts` handles this with:
- Regex-based chunk splitting
- AI-assisted boundary detection for non-standard pages
- Incremental single-pass parsing for pages with known releases
- Fallback tool loops for pages with long navigation headers

The goal is to distill the knowledge embedded in those heuristics into guidelines that a capable model can follow directly, reducing code complexity while maintaining extraction quality.
