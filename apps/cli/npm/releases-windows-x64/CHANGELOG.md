# @buildinternet/releases-windows-x64

## 0.83.3

## 0.83.2

## 0.83.1

## 0.83.0

## 0.82.0

## 0.81.1

## 0.81.0

## 0.80.1

## 0.80.0

## 0.79.0

## 0.78.1

## 0.78.0

## 0.77.0

## 0.76.0

## 0.75.0

## 0.74.1

## 0.74.0

## 0.73.1

## 0.73.0

## 0.72.0

## 0.71.0

## 0.70.1

## 0.70.0

## 0.69.0

## 0.68.0

## 0.67.3

## 0.67.2

## 0.67.1

## 0.67.0

## 0.66.0

## 0.65.0

## 0.64.0

## 0.63.0

## 0.62.1

## 0.62.0

## 0.61.0

## 0.60.0

## 0.59.0

## 0.58.0

## 0.57.0

## 0.56.0

## 0.55.0

## 0.54.0

## 0.53.0

## 0.52.0

## 0.51.0

## 0.50.0

## 0.49.0

## 0.48.0

### Patch Changes

- 9e3147f: `releases admin overview get` now shows the overview's most recent update time when it differs from the original generation time, while keeping the release and citation counts in the summary line.

## 0.47.0

### Minor Changes

- 5c6b819: Add `--max-content-chars [n]` to `releases admin overview inputs`. In `--json` mode it clips each `selected[].content` to at most `n` characters client-side before printing (bare flag defaults to 1000), leaving every other field — `existingContent`, `media`, `totalAvailable`, and the `selected` length itself — untouched. High-volume orgs emit 500K+ chars of full release content here (sentry's largest single release is ~125K), which exceeds the ~30K Bash stdout cap a Claude Code sub-agent reads through and gets silently truncated, so the overview would be generated from only the first few releases. The clip is purely client-side — the CLI still receives the full payload over the wire — so it removes that footgun without the multi-step `jq` workaround. Omitting the flag preserves today's full-content output.

## 0.46.0

### Minor Changes

- f38f166: Add `releases admin work start <batch>` / `status` / `end` and a sticky run-dir pointer for the maintenance workspace. `RELEASES_RUN_DIR` auto-captures admin mutations into `mutations.jsonl` and defaults the managed-session trace dir, but a one-time `export` doesn't survive an agent harness (each shell is fresh), so logging silently stopped after the first command. `work start` creates `~/.releases/work/runs/<ts>-<batch>/` (honoring `RELEASES_DATA_DIR`) and writes a sticky `~/.releases/work/.current-run` pointer; the CLI now resolves the active run as `RELEASES_RUN_DIR` env → `.current-run` pointer → none, so mutation logging and the trace-dir default work across separate invocations with no env threading. Explicit `RELEASES_RUN_DIR` still wins. `work status` prints the run dir, where it came from, and a mutations/sessions tally; `work end` clears the pointer.

### Patch Changes

- 3f70b35: `releases admin overview update` now always HTML-entity-decodes the content body before uploading. The five entities sub-agents reflexively over-escape when relaying markdown (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;` — e.g. `Q&amp;A`, `streams.input&lt;T&gt;`) are a transport artifact, not authored content, and the API stores the body verbatim — so an un-decoded entity rendered wrong. The decode is single-pass and idempotent, so an already-clean body (including one a caller pre-decoded to compute citation offsets) is unchanged. `--unescape-html` is now the default and kept as an accepted no-op flag for back-compat.
- dc7c707: `releases admin overview get` now surfaces inline citations. The table line includes a citation count alongside the release count, and `--json` adds `citationCount` plus the full `citations` array. The org overview GET already returns citations ordered by character position — this exposes them so a post-write `overview get` can verify what `overview update` reported (which echoes `citations: N`) without a re-write.

## 0.45.0

## 0.44.0

## 0.43.0

## 0.42.0

## 0.41.0

## 0.40.1

## 0.40.0

## 0.39.0

## 0.38.1

## 0.38.0

## 0.37.0

## 0.36.0

## 0.35.3

## 0.35.2

## 0.35.1

## 0.35.0

## 0.34.0

## 0.33.0

## 0.32.0

## 0.31.0

## 0.30.0

## 0.29.0

## 0.28.1

## 0.28.0

## 0.27.0

## 0.26.0

## 0.25.0

## 0.24.0

## 0.23.0

### Minor Changes

- c80aacb: feat(cli): publish a Windows x64 binary. `npm install -g @buildinternet/releases` now works on Windows; the dispatcher resolves `releases.exe` from the new `@buildinternet/releases-windows-x64` platform package. Homebrew remains macOS/Linux-only. `windows-arm64` is intentionally not shipped — open an issue if you need it.
