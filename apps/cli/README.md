# Release Notes Index CLI

[![npm](https://img.shields.io/npm/v/@buildinternet/releases?color=cb3837&label=npm&logo=npm)](https://www.npmjs.com/package/@buildinternet/releases)
[![CI](https://github.com/buildinternet/releases/actions/workflows/ci.yml/badge.svg)](https://github.com/buildinternet/releases/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Backend](https://img.shields.io/badge/backend-buildinternet%2Freleases-24292e?logo=github)](https://github.com/buildinternet/releases)
[![skills.sh](https://skills.sh/b/buildinternet/releases)](https://skills.sh/buildinternet/releases)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/buildinternet/releases)

**[Release Notes Index](https://releases.sh)** &nbsp;·&nbsp; **[Backend monorepo →](https://github.com/buildinternet/releases)** &nbsp;·&nbsp; [Install](#install) &nbsp;·&nbsp; [Usage](#usage) &nbsp;·&nbsp; [Authentication](#authentication)

The command-line client for [Release Notes Index](https://releases.sh), the changelog & release-notes registry for developers and AI agents. It's a lean HTTP client: search and browse release notes from GitHub, RSS/Atom/JSON feeds, and product changelog pages, with no local infrastructure.

The CLI lives in the [buildinternet/releases](https://github.com/buildinternet/releases) monorepo under `apps/cli/`, next to the backend that powers `api.releases.sh` (API worker, MCP server, web frontend, ingest pipeline).

The CLI talks to the hosted registry at `api.releases.sh`. **Search and browse work out of the box — no account or config.** Sign in with `releases login` to follow orgs and products, get a personalized feed, and manage outbound webhooks; it mints a personal **read-only** API key (and earns you higher rate limits as those roll out). Write/admin access (`releases admin …`) is a separate, closed beta — open an issue for early access.

## Install

```bash
brew install buildinternet/tap/releases          # Homebrew (macOS / Linux)
npm install -g @buildinternet/releases           # npm (macOS / Linux / Windows)
curl -fsSL https://releases.sh/install | bash    # shell installer (macOS / Linux)
```

Or run without installing: `npx @buildinternet/releases@latest search react` — always pin `@latest`, since bare `npx @buildinternet/releases` caches the first-fetched version forever. Signed, precompiled binaries for every platform are on the [Releases page](https://github.com/buildinternet/releases/releases) (with checksums) for air-gapped installs or version pinning.

Homebrew installs shell completions automatically. On every other path, enable them once with `releases completion install` (auto-detects `$SHELL`).

## Usage

```bash
releases search "authentication"
releases search "slack integration" --since 90d   # bound release hits by publish date
releases tail next-js                              # latest releases; `tail -f` to follow
releases list --category ai
releases get vercel                                # org, product, or source
releases org overview vercel                       # full AI-generated org overview
releases stats
releases changelog                                 # recent product updates from releases.sh
releases submit https://acme.dev/changelog         # suggest a source for the registry
releases feedback "great tool — here's an idea…"   # message the maintainers
```

Identifiers are interchangeable: every command accepts a slug, a typed ID (`org_…`, `prod_…`, `src_…`, `rel_…`), or an `org/slug` coordinate (e.g. `vercel/next-js`). IDs are stable across renames. `search`, `tail`/`latest`, and `feed` take `--since` / `--until` to bound releases by date — an ISO date (`2026-01-01`) or relative shorthand (`90d`, `4w`, `6m`, `2y`).

Add `--json` to any reader command for machine-readable output — list commands emit a `{ items, pagination }` envelope. Release readers return a slim shape by default (id, version, title, summary, excerpt, url, dates, plus any `media` with its `r2Url`); pass `--full` for the complete payload. `tail`/`latest` take `--count` (alias `--limit`, 1–100). Run `releases <command> --help` for per-command flags.

### Following & personalized feed

Follow orgs and products to build a personalized feed. These act on your own account, so sign in first (`releases login`):

```bash
releases follow vercel              # org slug, org/product coordinate, or typed ID
releases following                  # list what you follow
releases feed                       # your release timeline (--json, --page, --limit)
releases unfollow vercel
```

Following an organization includes all of its products.

### Outbound webhooks

Receive signed `release.created` POSTs in real time — for everything you follow or a single org:

```bash
releases webhook add --scope follows --url https://your.app/hook
releases webhook add --org vercel --url https://your.app/hook --description "prod"
releases webhook list
releases webhook test <id>
releases webhook verify --key … --signature … --timestamp … --body-file capture.json
```

Org-scoped: up to 10 (`--org`, optional `--source`, `--product`, `--type feature|rollup`). Follows-scoped: one webhook (`--scope follows`) that tracks your current follow graph; optional `--type` narrows delivery. Signing keys are shown once on `add` / `rotate-secret`. You can also manage webhooks in the browser at [releases.sh/account/notifications](https://releases.sh/account/notifications). Operator/admin webhooks (`releases admin webhook …`) are a separate root-key surface.

Add `--workspace <id-or-slug>` to `list`, `add`, `show`, `edit`, `remove`, `test`, or `rotate-secret` to manage a shared workspace webhook instead of your own — see one you belong to, and its role and id, with `releases workspace list`:

```bash
releases workspace list
releases webhook add --workspace acme --org vercel --url https://your.app/hook
releases webhook list --workspace acme
```

Workspace webhooks are org-scoped only (`--scope follows` isn't supported with `--workspace`). Only workspace owners and admins can create, edit, rotate, or delete them; any member can list, view, and test.

### Contribute to the registry

None of these need an account or API key:

```bash
releases submit https://acme.dev/changelog       # suggest a changelog / release-notes URL
releases feedback "tail -f reconnects slowly"     # report a bug or share an idea
releases json validate releases.json              # check a releases.json manifest before publishing
```

`submit` and `feedback` both prompt interactively when run with no argument, accept input on stdin, and take `--dry-run --json` to preview the payload without sending. `feedback --type` is `bug` / `idea` / `other`; `submit --note` carries extra context (product name, repo, feed quirks). Submissions feed the same review queue as the [web submit form](https://releases.sh/submit).

`json validate` is a read-only manifest check: it validates a [`releases.json`](https://releases.sh/docs/listing) v2 file against the published schema (pass a path or `-` for stdin) and adds `--json` for machine-readable output — no network, no submission.

### MCP & agent plugins

Point any MCP-compatible agent at the hosted server:

```bash
npx mcp-remote https://agents.releases.sh/mcp
```

This repo also ships the `releases` plugin (`plugins/claude/releases`) — hosted MCP tools, a `/releases` lookup command, and auto-trigger skills — in the common agent-plugin layout. In Claude Code:

```bash
/plugin marketplace add buildinternet/releases
/plugin install releases@releases
```

Other agent marketplaces (Grok Build via the [xAI plugin marketplace](https://github.com/xai-org/plugin-marketplace), and more as they are listed) install the same folder. Per-agent steps are in the [plugin README](plugins/claude/releases/README.md).

Operator/maintainer skills (source onboarding, parsing, playbooks) live with the backend in the [releases monorepo](https://github.com/buildinternet/releases) — its `.claude/skills/` tree is picked up automatically in a checkout.

Or install just the skills into any agent (Cursor, Codex, Gemini CLI, Windsurf, …):

```bash
releases skills install        # or, without the CLI: npx skills add buildinternet/releases
```

## Authentication

Search and browse need no auth. Signing in powers the personal surfaces — **follows, feed, and outbound webhooks** — and mints a personal **read-only** key (it can't write to the catalog or run `admin` commands; it identifies you for `/v1/me/*` account routes). The easiest way in is your browser — nothing to copy or paste:

```bash
releases login              # opens your browser to approve, then saves the key
releases login --no-browser # print the URL + code to open yourself (headless / SSH)
```

This uses the OAuth 2.0 Device Authorization Grant (RFC 8628): approve a short code at [releases.sh/device](https://releases.sh/device) in a signed-in browser, and a read-only key is saved to `~/.releases/credentials` (`0600`) — **the browser session itself is never saved**, only that key. Manage keys with `releases keys list` / `create` / `revoke`; each of those opens its own fresh browser approval and signs out again once the command finishes, rather than reusing a stored session (add `--no-browser` to print the URL + code instead, same as `login`).

If you've verified ownership of a source's domain, mint a `publish-token` scoped to that one source. The [`publish-changelog` GitHub Action](https://releases.sh/docs/integrations/github-actions) and `releases publish` both read it as `RELEASES_API_TOKEN`. Like `releases keys`, this opens its own browser approval each time:

```bash
releases publish-token create --source src_… | gh secret set RELEASES_API_TOKEN
releases publish-token list
releases publish-token revoke <id>
```

Already issued a token (e.g. a write/admin key during the closed beta)? Store it without the browser flow via `releases auth login` (interactive, `--token <token>`, or `--token -` for stdin); it's verified before being saved. `releases auth status` shows the current state (`whoami` is an alias). `RELEASES_API_KEY` in the environment overrides any stored credential — handy for CI.

## Publish from any CI

`releases publish` pushes changelog updates with `POST /v1/sources/…/releases/batch` (`mode: upsert-content`) — the same request as the [publish-changelog GitHub Action](https://releases.sh/docs/integrations/github-actions), for GitLab CI, Buildkite, or a local docs build.

```bash
releases publish --source src_… --dry-run
releases publish --source acme/docs --changelog CHANGELOG.md --since "$CI_COMMIT_BEFORE_SHA" \
  --url-template "https://gitlab.com/acme/app/-/blob/main/CHANGELOG.md#{key}"
releases publish --source src_… --glob "changelog/**/*.mdx"
```

`--dry-run` prints the batch body and does not call the API (no token required). A real publish reads `RELEASES_API_TOKEN` and exits if it is missing. `--since <sha>` limits the plan to entries changed since that commit; omit it, or pass an all-zero first-push SHA, to publish every parsed entry. Repeating a publish is safe: unchanged bodies are not written again.

Single-file mode parses versioned `##` headings (Keep a Changelog, conventional-changelog) and `## Month D, YYYY` sections. `--glob` switches to one MDX or Markdown file per release, with metadata in YAML frontmatter (`draft: true` is skipped). Deleted files are reported and left in the index.

The commit you pass to `--since` has to be in the local clone (`fetch-depth: 0` on GitHub, or GitLab's default full clone). `--url-template` accepts `{key}`, `{version}`, `{date}`, `{path}`, and `{slug}`. When `GITHUB_REPOSITORY` is set and the template is omitted, the URL falls back to the file's GitHub blob URL, same as the Action.

```yaml
# .gitlab-ci.yml
publish-changelog:
  image: node:22
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
      changes: [CHANGELOG.md]
  script:
    - npm install -g @buildinternet/releases
    - |
      releases publish \
        --source "$RELEASES_SOURCE" \
        --since "$CI_COMMIT_BEFORE_SHA" \
        --url-template "https://gitlab.com/${CI_PROJECT_PATH}/-/blob/${CI_COMMIT_REF_NAME}/CHANGELOG.md#{key}"
```

## Environment

Reader access requires nothing. Useful overrides:

- `RELEASES_API_KEY` — Bearer token for write endpoints; overrides stored credentials.
- `RELEASES_API_TOKEN` — write-scoped publish token for `releases publish` (see [Publish from any CI](#publish-from-any-ci)).
- `RELEASES_API_URL` — override the default `https://api.releases.sh` (e.g. staging).
- `RELEASES_TELEMETRY_DISABLED=1` — opt out of anonymous usage pings (`DO_NOT_TRACK=1` also honored).

See [`.env.example`](./.env.example) for the full list.

### Custom CA certificates (TLS-intercepting proxies)

The compiled binary ships with the standard Mozilla CA store. If your network re-terminates TLS with its own CA (corporate proxy, sandboxed agent environment), point the standard Node/OpenSSL variables at the proxy's CA certificate — the binary honors both:

```sh
NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.pem releases search "bun"
# or
SSL_CERT_FILE=/path/to/proxy-ca.pem releases search "bun"
```

No `--ca-bundle` flag is needed; certificate errors from the CLI include this hint.

## Exit codes

| Code  | Meaning                                                      |
| ----- | ------------------------------------------------------------ |
| `0`   | Success                                                      |
| `1`   | Application error (network, API, unexpected state)           |
| `2`   | Usage / provider error (bad arguments or upstream rejection) |
| `130` | Cancellation (SIGINT)                                        |

## Contributing

Build, test, and release instructions live in the repo's [CONTRIBUTING.md](https://github.com/buildinternet/releases/blob/main/CONTRIBUTING.md#working-on-the-cli). To work from a checkout:

```bash
git clone https://github.com/buildinternet/releases.git
cd releases && bun install
bun apps/cli/src/index.ts --help
```

File issues at [buildinternet/releases/issues](https://github.com/buildinternet/releases/issues).

## License

MIT
