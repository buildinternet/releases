---
"@buildinternet/releases": patch
---

fix: harden CLI error handling, add compact/pagination flags, protect slug renames

- API PATCH `/sources/:slug` now supports slug renames with uniqueness checks and returns 400 (not 500) for unrecognized fields (#240)
- `releases admin source list` alias added for discoverability within admin workflows (#241)
- `releases list --json --compact` returns lightweight fields; `--limit`/`--page` for paginated output (#241)
- `releases admin source edit` accepts source IDs (`src_...`) alongside slugs
- Slug renames require `--confirm-slug-change` to prevent accidental web link breakage
- `--parse-instructions ""` treated as equivalent to `--no-parse-instructions`
- Commander's `showSuggestionAfterError` enabled with help hints on error output
