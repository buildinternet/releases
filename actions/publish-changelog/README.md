# Publish changelog to Releases Index

Reusable GitHub Action that turns a changelog push into upserted releases on [Releases Index](https://releases.sh).

On each run it diffs your changelog against the previous commit and posts the changed entries to the existing `POST /v1/sources/:id/releases/batch` route (`mode: "upsert-content"`). Re-running the same commit is a no-op: URLs are stable and the batch upsert only writes when content actually changed.

Two modes, mutually exclusive:

- **Single-file** (default) — one `CHANGELOG.md` with `##` sections.
- **Directory** — one MDX/Markdown file per release, metadata in YAML frontmatter. Set `changelog-glob` to turn this on.

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

`actions/checkout` must use `fetch-depth: 0` so the Action can `git show`/`git diff` against the previous commit.

## Inputs

| Input               | Required | Default                                          | Notes                                                                                                                                                |
| ------------------- | -------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`            | yes      |                                                  | `src_…` id, or a source slug (then pass `org`)                                                                                                       |
| `org`               | no       |                                                  | Organization slug, for `/v1/orgs/:org/sources/:source/releases/batch`                                                                                |
| `api-token`         | yes      |                                                  | A publish token for this source (self-serve for verified domain owners, see below), or a write-scoped `relk_…`. Read-only `relu_` keys are rejected. |
| `api-url`           | no       | `https://api.releases.sh`                        |                                                                                                                                                      |
| `changelog-path`    | no       | `CHANGELOG.md`                                   | Single-file mode. Must stay at its default when `changelog-glob` is set.                                                                             |
| `changelog-glob`    | no       | `""`                                             | Directory mode. e.g. `changelog/**/*.mdx`, resolved relative to `working-directory`. Cannot be combined with a non-default `changelog-path`.         |
| `working-directory` | no       | repo root                                        |                                                                                                                                                      |
| `before-sha`        | no       | `github.event.before`                            |                                                                                                                                                      |
| `url-template`      | no       | GitHub blob URL (+ `#{key}` in single-file mode) | Placeholders `{key}`, `{version}`, `{date}`, `{path}`, `{slug}`                                                                                      |
| `generate-content`  | no       | `true`                                           | Admin-token regenerate for edited entries; write and publish tokens skip                                                                             |

### Publish tokens

If you've verified you own your domain, you can mint a token yourself that publishes to one source and nothing else. While signed in to releases.sh (browser session, not an API key), call `POST https://api.releases.sh/v1/me/publish-tokens` with `{"sourceId": "src_…", "name": "github-actions"}`. The token is shown once. Store it as `RELEASES_API_TOKEN`. List tokens with `GET /v1/me/publish-tokens` and revoke one with `DELETE /v1/me/publish-tokens/:id`. A token stops working if you revoke it or lose the ownership claim.

The request must come from a signed-in releases.sh page, because the API only accepts it from that origin. Until the account page has a button, run this in the browser console on releases.sh:

```js
const res = await fetch("https://api.releases.sh/v1/me/publish-tokens", {
  method: "POST",
  credentials: "include",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sourceId: "src_…", name: "github-actions" }),
});
console.log(await res.json());
```

## Outputs

| Output     | Notes                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `added`    | Newly added entries published.                                                                                                            |
| `modified` | Edited entries published.                                                                                                                 |
| `deleted`  | Directory mode only: files matching `changelog-glob` that were deleted. Reported only — the Action never deletes releases from the index. |
| `inserted` | `inserted` count returned by the batch upsert (`0` on an identical re-run).                                                               |

## Accepted changelog formats (single-file mode)

- **Versioned** Keep a Changelog / conventional-changelog (`## [1.4.0] - 2026-05-01`)
- **Date-sectioned** (`## June 10, 2026`) — the format this repo publishes

Unreleased / prose `##` headings are skipped.

## Directory mode (MDX)

Set `changelog-glob` instead of `changelog-path` when release notes live as one MDX/Markdown file per entry — the layout used by Mintlify, Fumadocs, Docusaurus, Astro content collections, and Nextra.

```yaml
name: Publish changelog

on:
  push:
    branches: [main]
    paths:
      - changelog/**

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
          changelog-glob: changelog/**/*.mdx
```

Each matched file's YAML frontmatter supplies the metadata (first match wins):

| Field   | Frontmatter keys                                                                           |
| ------- | ------------------------------------------------------------------------------------------ |
| title   | `title` (else the first `# ` heading, else the filename)                                   |
| date    | `date`, `publishedAt`, `published`, `pubDate`                                              |
| version | `version`                                                                                  |
| slug    | `slug` (else the file's path, minus its extension, relative to the glob's static base dir) |
| url     | `url`, `canonical` (else `url-template`, else the file's GitHub blob URL)                  |

`draft: true` skips the file entirely — it is never published, added, or counted.

The body is converted to plain markdown: `import`/`export` lines are stripped, JSX components are flattened to their text children (`<Callout>Hi</Callout>` → `Hi`), `<img>`/`<Image>` tags become markdown images, and `<a href>` tags become markdown links. Fenced code blocks, inline code, regular markdown, links, and images pass through untouched. This is a small regex-based pass — no MDX compiler — so unusual JSX (multi-line imports, custom self-closing tags other than images) may need a manual look at the published body. Quote numeric versions in frontmatter (`version: "1.10"`): YAML reads an unquoted `1.10` as the number `1.1`.

Changed files come from `git diff --name-status` against `before-sha`. Added and modified files are upserted; renames land as modified at the new path; deleted files are reported in the `deleted` output and logs but left alone in the index — removing a release is a curator action, not something a push automates. On the very first push to a source (no previous commit to diff), every file matching the glob is published, mirroring single-file mode's behavior on an empty changelog.

## Secrets

Treat `RELEASES_API_TOKEN` like a password. Rotate it if it leaks. The Action never prints the token.
