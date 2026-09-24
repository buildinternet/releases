---
title: Publish from GitHub Actions
description: Push changelog markdown from a Git repo into Releases Index on every merge — no scrape polling.
---

# Publish from GitHub Actions

If your release notes live in git (`CHANGELOG.md`, Keep a Changelog, a dated product log), a GitHub Action can create or update the matching releases in Releases Index the moment the file lands on your default branch. You do not wait for scrape polling.

Re-running the same commit is safe. Each section is keyed by a stable URL, and the batch upsert only writes when the body actually changed.

## 1. Create a write token

The Action calls `POST /v1/sources/…/releases/batch`, which needs a **write-scoped** machine token (`relk_…`).

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

`fetch-depth: 0` is required. A shallow clone cannot `git show` the file at `github.event.before`.

## Inputs

| Input               | Required | Notes                                                                                                                                               |
| ------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`            | yes      | `src_…` id, or a source slug (then set `org`)                                                                                                       |
| `org`               | no       | Organization slug for the org-scoped batch route                                                                                                    |
| `api-token`         | yes      | Write-scoped `relk_…`                                                                                                                               |
| `api-url`           | no       | Defaults to `https://api.releases.sh`                                                                                                               |
| `changelog-path`    | no       | Defaults to `CHANGELOG.md`                                                                                                                          |
| `working-directory` | no       | Subdirectory in a monorepo                                                                                                                          |
| `url-template`      | no       | See [Stable URLs](#stable-urls)                                                                                                                     |
| `generate-content`  | no       | Defaults to `true`. Admin tokens regenerate summaries for edited sections; write-only tokens skip this (batch already queues the fill for new rows) |

Path filters stay on your workflow `on.push.paths` — the Action does not decide which pushes run.

## Changelog formats

The Action reads `##` headings:

- **Versioned** — Keep a Changelog / conventional-changelog, e.g. `## [1.4.0] - 2026-05-01`. `[Unreleased]` is skipped.
- **Date-sectioned** — `## June 10, 2026`, newest first. This is the format [releases.sh](https://releases.sh/updates) publishes.

Other heading styles are ignored. If the file changed but nothing parsed, the Action fails so a silent no-op cannot hide a format mistake.

## Stable URLs

Idempotency is `(source, url)`. The Action prefers a permalink already in the heading (common on conventional-changelog compare links). Otherwise it fills `url-template`.

Placeholders: `{key}` (version or `YYYY-MM-DD`), `{version}`, `{date}`, `{path}`.

Default when you omit the template:

```text
https://github.com/<owner>/<repo>/blob/<branch>/<path>#{key}
```

To keep human URLs on a docs site:

```yaml
url-template: https://example.com/changelog/{date}
```

Do not put the commit SHA in the URL. A later edit to the same version would insert a second release instead of updating the first.

## What happens on the server

The Action does **not** invent a second write path. It posts the same batch body the rest of ingest uses:

```http
POST /v1/sources/{source}/releases/batch
{ "mode": "upsert-content", "releases": [ { "title", "content", "url", "publishedAt", "type" } ] }
```

That upsert triggers the usual side effects: content generation for new rows, embeddings, live events, and web revalidation. An identical re-run returns `inserted: 0`.

## Secrets

Treat `RELEASES_API_TOKEN` like a password. Rotate it if it leaks. The Action never prints the token.
