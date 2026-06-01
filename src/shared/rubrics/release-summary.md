# Release summary faithfulness rubric

The artifact is a generated `summary` (and `title_short`) for a single software
release. The body it was generated from is provided as context in the artifact.
Grade each criterion independently.

## Criteria

1. **Faithful to the body.** Every claim in the summary is supported by the
   release body. No invented features, versions, numbers, or capabilities.
2. **No contradiction.** The summary does not state anything the body
   contradicts (e.g. calling a removal an addition).
3. **Leads with the user-facing outcome.** The summary foregrounds what changed
   for the user, not internal mechanism or marketing framing.
4. **No marketing fluff.** No hype adjectives ("thrilled", "game-changing",
   "most powerful") carried over from a promotional body; the real change is
   surfaced even when buried.
5. **No format leakage.** No raw XML tags, markdown code fences, or echoed input
   labels ("Body:", "Title:").
