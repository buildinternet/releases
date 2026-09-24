---
title: Publish from GitHub Actions
description: Push changelog markdown from a Git repo into Releases Index on every merge — no scrape polling.
---

# Publish from GitHub Actions

If your release notes live in git — `CHANGELOG.md`, Keep a Changelog, a dated product log, or one MDX file per release — a GitHub Action can create or update the matching releases in Releases Index the moment the file lands on your default branch. You do not wait for scrape polling.

Re-running the same commit is safe. Each entry is keyed by a stable URL, and the batch upsert only writes when the body actually changed.

The Action has two modes:

- **Single-file** (default) — one changelog file with `##` sections.
- **Directory** — one MDX or Markdown file per release, metadata in YAML frontmatter. Used by sites built with Mintlify, Fumadocs, Docusaurus, Astro content collections, or Nextra.

## 1. Create a token

The Action calls `POST /v1/sources/…/releases/batch`. Two kinds of `relk_…` token work:

- **A publish token** (the usual choice). If you've verified you own your domain (an ownership claim through the listing flow), you can mint one yourself. It can publish to one source and nothing else: no source edits, no other sources. It stops working if you revoke it or lose the claim. While you're signed in to releases.sh, call `POST /v1/me/publish-tokens` with `{"sourceId": "src_…", "name": "github-actions"}`. The response shows the token once. `GET /v1/me/publish-tokens` lists your tokens and `DELETE /v1/me/publish-tokens/:id` revokes one. These routes need your browser sign-in session; an API key won't work. A button on your account page is coming.
- **A write-scoped machine token**, issued by a Releases Index admin.

Read-only user keys (`relu_…`, including `releases login`) are rejected. Store the token as a repository secret named `RELEASES_API_TOKEN`.

## 2. Point it at a source

You need the source the Action should write to — preferably the typed id (`src_…`) from the source page or `releases admin source list`. A slug works if you also pass the organization.

If this Action is the _only_ way that source ever gets new content, mark it push-fed so we stop polling it: `PATCH /v1/sources/:slug/metadata` with body `{"ingestMode": "push"}`. The source page then shows a "Last Published" time instead of "Last Checked", and `lastFetchedAt` advances on every batch write instead of a scrape.

## 3. Add the workflow

Copy the committed example at [`actions/publish-changelog/examples/publish-changelog.yml`](https://github.com/buildinternet/releases/blob/main/actions/publish-changelog/examples/publish-changelog.yml) into your repo's `.github/workflows/`. Replace the `source` id and `RELEASES_API_TOKEN` secret. Do not copy this repo's dogfood `.github/workflows/changelog-publish.yml` — that file pins our source and updates URL.

Checkout with full history so the Action can diff against the previous commit, then call the Action:

```yaml
name: Publish changelog

on:
  push:
    branches: [main]
    paths:
      - CHANGELOG.md
      # or: docs/**, .changeset/**

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 10
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

`fetch-depth: 0` is required. A shallow clone cannot `git show`/`git diff` against `github.event.before`.

## Inputs

| Input               | Required | Notes                                                                                                                                                     |
| ------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`            | yes      | `src_…` id, or a source slug (then set `org`)                                                                                                             |
| `org`               | no       | Organization slug for the org-scoped batch route                                                                                                          |
| `api-token`         | yes      | A publish token for this source, or a write-scoped `relk_…`                                                                                               |
| `api-url`           | no       | Defaults to `https://api.releases.sh`                                                                                                                     |
| `changelog-path`    | no       | Single-file mode. Defaults to `CHANGELOG.md`. Must stay default when `changelog-glob` is set.                                                             |
| `changelog-glob`    | no       | Directory mode. e.g. `changelog/**/*.mdx`. See [Directory mode](#directory-mode-mdx-and-markdown). Cannot combine with a non-default `changelog-path`.    |
| `working-directory` | no       | Subdirectory in a monorepo                                                                                                                                |
| `url-template`      | no       | See [Stable URLs](#stable-urls)                                                                                                                           |
| `generate-content`  | no       | Defaults to `true`. Admin tokens regenerate summaries for edited entries; write and publish tokens skip this (batch already queues the fill for new rows) |

Path filters stay on your workflow `on.push.paths` — the Action does not decide which pushes run.

## Changelog formats (single-file mode)

The Action reads `##` headings:

- **Versioned** — Keep a Changelog / conventional-changelog, e.g. `## [1.4.0] - 2026-05-01`. `[Unreleased]` is skipped.
- **Date-sectioned** — `## June 10, 2026`, newest first. This is the format [releases.sh](https://releases.sh/updates) publishes.

Other heading styles are ignored. If the file changed but nothing parsed, the Action fails so a silent no-op cannot hide a format mistake.

## Directory mode (MDX and Markdown)

Some sites keep one file per release instead of a single changelog: a `changelog/` folder of dated MDX files (Mintlify), or a blog-style folder per entry with a `slug` field (Fumadocs, Docusaurus, Astro, Nextra). Set `changelog-glob` instead of `changelog-path` to read that layout — the two options are mutually exclusive.

```yaml
- uses: buildinternet/releases/actions/publish-changelog@main
  with:
    source: src_…
    api-token: ${{ secrets.RELEASES_API_TOKEN }}
    changelog-glob: changelog/**/*.mdx
```

The Action reads each matched file's YAML frontmatter. The first field that matches wins:

- **title** — `title`, else the first `# ` heading in the body, else the filename
- **date** — `date`, `publishedAt`, `published`, or `pubDate`
- **version** — `version`
- **slug** (the stable key) — `slug`, else the file's path minus its extension, relative to the glob's static base directory (the part of the glob before the first wildcard)
- **url** — `url` or `canonical`, else `url-template`, else the file's GitHub blob URL

A file with `draft: true` in its frontmatter is skipped — never published, never counted.

The body is turned into plain markdown: `import`/`export` lines are removed, JSX components collapse to their text content (`<Callout type="info">Hi</Callout>` becomes `Hi`), and `<img>`/`<Image>` tags become markdown images. Fenced code blocks, ordinary markdown, links, and images pass through unchanged. This is a conservative line-based pass, not a full MDX compiler — unusual constructs (a multi-line `import`, a custom self-closing component other than an image) can slip through untouched, so check the first run's published body.

**Change detection** comes from `git diff --name-status` between `before-sha` and the current commit, filtered to the glob. Added and modified files are upserted; a rename lands as a modified entry at its new path; a deleted file is reported in the `deleted` output and the logs but is **not** removed from Releases Index — deleting a release is a decision for a curator, not something a push should do automatically. On the very first push (no earlier commit to diff against), every file matching the glob is published, the same way single-file mode publishes an entire changelog the first time it sees one.

## Stable URLs

Idempotency is `(source, url)`. In single-file mode the Action prefers a permalink already in the heading (common on conventional-changelog compare links). In directory mode a frontmatter `url`/`canonical` wins. Otherwise both modes fall back to `url-template`.

Placeholders: `{key}` (version, `YYYY-MM-DD`, or the directory-mode slug), `{version}`, `{date}`, `{path}`, `{slug}` (directory-mode alias for `{key}`).

Default when you omit the template:

```text
https://github.com/<owner>/<repo>/blob/<branch>/<path>#{key}   # single-file mode
https://github.com/<owner>/<repo>/blob/<branch>/{path}          # directory mode
```

To keep human URLs on a docs site:

```yaml
url-template: https://example.com/changelog/{slug}
```

Do not put the commit SHA in the URL. A later edit to the same version (or the same file) would insert a second release instead of updating the first.

## What happens on the server

The Action does **not** invent a second write path. It posts the same batch body the rest of ingest uses:

```http
POST /v1/sources/{source}/releases/batch
{ "mode": "upsert-content", "releases": [ { "title", "content", "url", "publishedAt", "type" } ] }
```

That upsert triggers the usual side effects: content generation for new rows, embeddings, live events, and web revalidation. An identical re-run returns `inserted: 0`.

## Secrets

Treat `RELEASES_API_TOKEN` like a password. Rotate it if it leaks. The Action never prints the token.
