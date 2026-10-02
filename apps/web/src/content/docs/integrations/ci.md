---
title: Publish from any CI
description: Post changelog entries to Releases Index from GitLab, Buildkite, or any other CI with the same batch write the GitHub Action uses.
---

# Publish from any CI

The [GitHub Action](/docs/integrations/github-actions) is one client of a single write: `POST /v1/sources/{source}/releases/batch` with `mode: "upsert-content"`. GitLab CI, Buildkite, CircleCI, or a docs build can post that same body. There is no second ingest path.

Re-running the same entries is safe. Each release is keyed by a stable URL, and the batch upsert only writes when the body actually changed. An identical re-run returns `inserted: 0`.

`releases publish` (in the [CLI](/docs/installation)) will build this body for you — single-file `##` sections or one MDX file per entry, `--dry-run` to print the JSON, `--since <sha>` to diff. It uses the same planner as the Action. Until that command ships, post the JSON yourself with `curl`.

## 1. Create a token

The request needs a Bearer token that can write this source:

- **A publish token** (the usual choice). After you verify domain ownership, mint one under [Account → Webhooks & API](/account/webhooks). It can publish to one source and nothing else.
- **A write-scoped machine token**, issued by a Releases Index admin.

Read-only user keys (`relu_…`, including `releases login`) are rejected. Store the token as `RELEASES_API_TOKEN` in CI. Treat it like a password.

The token steps, including `releases publish-token create`, are on [Publish from GitHub Actions](/docs/integrations/github-actions#1-create-a-token).

## 2. Point it at a source

Use the typed source id (`src_…`). A slug works on the org-scoped route if you also know the organization: `POST /v1/orgs/{org}/sources/{slug}/releases/batch`.

The first successful write made with a publish token marks the source as **push-fed**: we stop polling it, because your CI is now how it gets new content. The source page shows "Last Published" instead of "Last Checked".

If the changelog lives in a git repo, say so in [`releases.json`](/docs/listing) with a push locator. `publish` is only `"push"`, and it needs both `github` and `path` (the file or glob your CI reads):

```json
{
  "github": "acme/docs",
  "path": "changelog/**/*.mdx",
  "publish": "push"
}
```

We create that source only after the domain ownership claim is verified. An unverified manifest leaves the locator declared and does not flip an existing source to push. `path` with a `*` is directory mode (`changelog-glob` on the Action); a path with no wildcard is one file (`changelog-path`).

## 3. POST the batch

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${RELEASES_API_TOKEN}" \
  --header "Content-Type: application/json" \
  --url "https://api.releases.sh/v1/sources/${RELEASES_SOURCE}/releases/batch" \
  --data @- <<'JSON'
{
  "mode": "upsert-content",
  "releases": [
    {
      "title": "1.4.0",
      "content": "### Added\n- JSON export",
      "url": "https://example.com/changelog#1.4.0",
      "publishedAt": "2026-05-01T12:00:00Z",
      "version": "1.4.0",
      "type": "feature",
      "prerelease": false
    }
  ]
}
JSON
```

`mode` must be `"upsert-content"`. Omitted, the route only fills empty fields and will not update an entry you edited. A typo in `mode` is a 400.

| Field         | Required | Notes                                                                                                  |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `title`       | yes      | Heading text. For a date section this is the date line (`June 10, 2026`).                              |
| `content`     | yes      | Markdown body under that heading, or the flattened MDX body.                                           |
| `url`         | yes      | Stable permalink. This is the idempotency key together with the source. Do not put a commit SHA in it. |
| `publishedAt` | no       | ISO-8601. A date-only changelog heading is sent as noon UTC (`2026-05-01T12:00:00Z`).                  |
| `version`     | no       | Semver or tag, when the entry has one.                                                                 |
| `type`        | no       | `"feature"` for a versioned entry, `"rollup"` for a date section.                                      |
| `prerelease`  | no       | `true` for alpha/beta/rc versions.                                                                     |

A successful response is `{ "inserted": <n>, "total": <n>, "insertedIds": ["rel_…"] }`. `inserted` counts new rows. An unchanged re-POST still returns 200 with `inserted: 0`.

Send only the entries that changed. The Action and `releases publish` do that by diffing since the previous commit (`before-sha` / `--since`). The HTTP route does not look at git — it upserts the array you send.

## GitLab CI

Variables: `RELEASES_API_TOKEN` (masked) and `RELEASES_SOURCE` (`src_…`). The job below posts one entry. Swap the JSON for the batch your changelog diff produced, or for the file `releases publish --dry-run` writes once that command is available.

```yaml
publish-changelog:
  stage: deploy
  image: curlimages/curl:8.11.1
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
      changes:
        - CHANGELOG.md
  script:
    - >
      curl --fail-with-body --silent --show-error
      --request POST
      --header "Authorization: Bearer ${RELEASES_API_TOKEN}"
      --header "Content-Type: application/json"
      --url "https://api.releases.sh/v1/sources/${RELEASES_SOURCE}/releases/batch"
      --data '{"mode":"upsert-content","releases":[{"title":"1.4.0","content":"### Added\n- JSON export","url":"https://example.com/changelog#1.4.0","publishedAt":"2026-05-01T12:00:00Z","version":"1.4.0","type":"feature"}]}'
```

The same `curl` works on Buildkite, CircleCI, or a script step. Checkout depth does not matter for the HTTP call. It matters only for the client that diffs the changelog (the Action needs `fetch-depth: 0`; `releases publish --since` needs the commit you name to be present).

## GitHub Actions

On GitHub, use the Action instead of hand-written JSON. It diffs `CHANGELOG.md` (or a `changelog-glob` of MDX files) and posts this body for you:

```yaml
- uses: buildinternet/releases/actions/publish-changelog@main
  with:
    source: src_…
    api-token: ${{ secrets.RELEASES_API_TOKEN }}
```

Inputs, directory mode, and URL templates: [Publish from GitHub Actions](/docs/integrations/github-actions).

## What the server does with the batch

The write is the same one ingest already uses. A new row gets content generation, embeddings, live events, and web revalidation. Deleting a file from the repo does not delete the release — that stays a curator action.
