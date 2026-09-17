# Publish changelog to Releases Index

Reusable GitHub Action that turns a changelog push into upserted releases on [Releases Index](https://releases.sh).

On each run it diffs `CHANGELOG.md` (or another path you pass) against the previous commit, maps the changed `##` sections to the existing `POST /v1/sources/:id/releases/batch` body (`mode: "upsert-content"`), and posts them. Re-running the same commit is a no-op: URLs are stable and the batch upsert only writes when content actually changed.

Docs: [Publish from GitHub Actions](https://releases.sh/docs/integrations/github-actions).

## Example

A committed copy-paste workflow lives in [`examples/publish-changelog.yml`](./examples/publish-changelog.yml). Copy that into your repo's `.github/workflows/` and replace the source id and secret. This repo's dogfood `.github/workflows/changelog-publish.yml` is not the template.

```yaml
name: Publish changelog

on:
  push:
    branches: [main]
    paths:
      - CHANGELOG.md

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          persist-credentials: false

      - uses: buildinternet/releases/actions/publish-changelog@main
        with:
          source: src_…
          api-token: ${{ secrets.RELEASES_API_TOKEN }}
```

`actions/checkout` must use `fetch-depth: 0` so the Action can `git show` the previous file.

## Inputs

| Input               | Required | Default                    | Notes                                                                 |
| ------------------- | -------- | -------------------------- | --------------------------------------------------------------------- |
| `source`            | yes      |                            | `src_…` id, or a source slug (then pass `org`)                        |
| `org`               | no       |                            | Organization slug, for `/v1/orgs/:org/sources/:source/releases/batch` |
| `api-token`         | yes      |                            | Write-scoped `relk_…`. Read-only `relu_` keys are rejected.           |
| `api-url`           | no       | `https://api.releases.sh`  |                                                                       |
| `changelog-path`    | no       | `CHANGELOG.md`             |                                                                       |
| `working-directory` | no       | repo root                  |                                                                       |
| `before-sha`        | no       | `github.event.before`      |                                                                       |
| `url-template`      | no       | GitHub blob URL + `#{key}` | Placeholders `{key}`, `{version}`, `{date}`, `{path}`                 |
| `generate-content`  | no       | `true`                     | Admin-token regenerate for edited days; write-only tokens skip        |

## Accepted changelog formats

- **Versioned** Keep a Changelog / conventional-changelog (`## [1.4.0] - 2026-05-01`)
- **Date-sectioned** (`## June 10, 2026`) — the format this repo publishes

Unreleased / prose `##` headings are skipped.
