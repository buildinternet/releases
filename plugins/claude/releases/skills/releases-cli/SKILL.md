---
name: releases-cli
description: Use the `releases` CLI to search, browse, and read the Release Notes Index from the terminal — the keyless, agent-friendly peer of the Releases MCP. Activate when the user mentions "releases CLI", runs a `releases` command, asks how to install it, wants to look up releases, sources, orgs, collections, or changelogs from a shell, or wants to publish a changelog from CI with `releases publish`.
---

# releases CLI

The `releases` CLI is a first-class, **keyless** way to query the public changelog registry at [releases.sh](https://releases.sh) — the terminal peer of the Releases MCP. Anyone can search, tail, list, and inspect releases with no account and no API key; it talks to `api.releases.sh` by default with zero configuration. (A separate, invite-only `admin` surface exists for maintainers — see the short note at the end — but reads never need it.)

Reach for the CLI when the user is working in a shell or wants piped/scriptable output; reach for the MCP when you're answering conversationally with typed tools. They cover the same registry.

## Install

```bash
brew install buildinternet/tap/releases    # recommended on macOS / Linux
npm install -g @buildinternet/releases      # or via npm
npx @buildinternet/releases search "react"  # one-off, no install
```

## Reader commands (no auth, no key)

Full reference: **[references/reader.md](references/reader.md)**. The shape is verb-first, and every command takes `--json`.

```bash
releases search "breaking change"      # unified search: orgs, catalog, collections, releases
releases tail next-js                  # latest releases from one source (slug or src_…)
releases tail --org vercel --count 20  # latest across a whole org
releases list --category ai            # browse sources (alias: `releases sources`)
releases list --query shadcn           # name / slug / url substring
releases get vercel                    # inspect any entity by id or slug
releases lookup domain vercel.com      # resolve a domain/URL to its registry entry
releases collection list               # browse curated cross-org playlists
releases collection releases frontier-ai-labs   # the feed for one collection
releases stats                         # registry overview
releases changelog                     # recent product updates from releases.sh
releases categories                    # valid --category values (fixed taxonomy)
```

Two commands built for agents specifically:

- `releases agent-context` — emits a versioned JSON document describing every command, argument, and option. When in doubt about exact flags, call this instead of guessing; it's the CLI's machine-readable source of truth.
- `releases skills install` — installs/refreshes the bundled skills (`-g` for user-wide). Symlinked by default, so re-running refreshes atomically.

### Conventions worth knowing (all in the reader reference)

- **IDs and slugs are interchangeable** wherever an identifier is expected (`org_…`, `prod_…`, `src_…`, `rel_…`); IDs are stable across renames. Source/product commands also take an `org/slug` coordinate (e.g. `vercel/vercel-ai-sdk`), which skips a resolver round-trip.
- **`--json` everywhere** for stable output. Release readers (`get`, `search`, `tail`) return a **slim** shape by default (core fields + markdown-stripped `excerpt` + `contentTokens` hint, plus `media[]` with R2 `r2Url` when present and a `contentTruncated` flag) to save tokens; pass `--full` for the complete payload. (`list` is the inverse: verbose by default — and carries a per-source `Releases` count column — `--compact` for less.) Narrow further with **`--fields id,version,source.slug`** (comma-separated, dot-notation for nested keys) to project the JSON down to just the leaves you need — on `get`/`search`/`tail`, composes with `--full`.
- **`tail`/`latest` row cap:** `--count` (alias `--limit`, clamped `1–100`) sets how many releases to return. Only the `--product` feed is cursor-paginated (`--cursor <token>`); the org-wide/global feeds are count-capped, so `--cursor` without `--product` errors.
- **`--page-all` for the whole list at once:** on the page-based list readers (`list`, `org list`, `admin product list`), `--json --page-all` walks every page and streams one item per line as NDJSON, so you don't have to loop `--page`/`--limit` or react to the truncation warning. Pipe it to `jq -c` or a stream parser. It's `--json`-only and can't be combined with `--page`.
- **Piped output is bare TSV** (no headers/color/truncation), so `releases list | cut -f2` works without parsing ANSI — but note release rows repeat the title across several columns, so check the layout or just use `--json` before slicing by column number. `COLUMNS=<n>` overrides detected width.
- **Errors are structured under `--json`.** When a command run with `--json` fails, it prints a parseable `{ "error": { "kind", "message", "status?", "method?", "path?", "field?" } }` to stdout (not a stderr text dump) and exits non-zero — so you can branch on `kind` (`"api"` / `"invalid_input"` / `"error"`) instead of string-matching. Identifiers are also validated before any request: control characters, `..` traversal, `%`/`?`/`#`, and whitespace are rejected with an `invalid_input` error.

### Reading a tracked changelog

`releases get <source> --json` reports `hasChangelogFile` and the `changelogUrl` keyless, so you can tell whether a source maintains a checked-in CHANGELOG.md. To read the **sliced content** keyless, use the MCP's `get_catalog_entry` (with `changelog_tokens` / `nextOffset`) or fetch the `changelogUrl` directly — the CLI's `releases admin source changelog` wrapper is key-gated and won't run without auth.

### Submitting a source (keyless)

`releases submit <url>` suggests a changelog or release-notes URL for the registry — the same review queue the [web submit form](https://releases.sh/submit) feeds, no key required. Scheme is optional (`https://` assumed); `--note` adds context and `--contact` an optional reply email. With no argument in a TTY it prompts; it also reads a piped URL from stdin. Its sibling `releases feedback "<message>"` sends product feedback the same keyless way. Maintainers triage submissions under the key-gated `releases admin recommendations …` (see the admin reference).

## Common Mistakes

- `releases list` lists sources (alias `releases sources`). Do NOT write `releases sources list` — it reads `list` as a source slug and fails with "Source not found: list".
- Default read cap is 200 releases per source; use `--max <n>` or `--all` to override.
- There is **no** `summary` or `compare` command in this CLI, and **no** AI summarization tools on the hosted MCP (`summarize_changes` / `compare_products` do not exist). To summarize or compare, read each entity with `releases get` / `releases tail` (or `--json`) and synthesize the answer yourself.
- Don't reach for `admin` commands to do reads — every read above is keyless. `admin` is only for registry maintenance and requires a key (below).

## Signed-in user commands (`releases login`)

After `releases login` (device flow) or with a stored `relu_` key, you can manage your own account state — no admin key required:

```bash
releases follow vercel              # follow an org or product
releases following                # list follows
releases feed                     # personalized release timeline

releases webhook list             # your outbound webhook subscriptions
releases webhook add --scope follows --url https://your.app/hook
releases webhook add --org vercel --url https://your.app/hook
releases webhook add --format slack --url https://hooks.slack.com/services/…
releases webhook add --format discord --url https://discord.com/api/webhooks/…
releases webhook test <id>        # enqueue a signed test delivery
releases webhook verify --key …   # local HMAC check (no auth)

releases workspace list           # workspaces you belong to (name, slug, id, role)
releases webhook list --workspace acme         # a workspace's shared webhooks instead of your own
releases webhook add --workspace acme --org vercel --url https://your.app/hook
```

Org-scoped webhooks: up to 10 per account (`--org`, optional `--source`, `--product`, `--type feature|rollup`). Follows-scoped: one webhook that tracks your current follow graph (real-time sibling to `feed` + digest email); optional `--type` narrows delivery. `webhook edit` can update filters (`--clear-source`, `--clear-product`, `--clear-type`). `--format slack` / `--format discord` post an unsigned chat card (the URL is the secret). JSON webhooks show a signing key once on `add` / `rotate-secret`. `--workspace <id-or-slug>` on `list`/`add`/`show`/`edit`/`remove`/`test`/`rotate-secret` manages a shared workspace webhook instead — org-scoped only, and only owners/admins can write (members can list/view/test). Operator/admin webhooks (`releases admin webhook …`) are a separate root-key surface.

## Admin surface (invite-only — reads never need it)

`releases admin <noun> <verb>` manages the registry (create/update sources, orgs, products; fetch; discovery; policies). It requires `RELEASES_API_KEY`, and **keys are not self-serve** — there's no public signup. Admin commands fail fast at startup without a key, so don't retry them unauthenticated, and don't fall back to them for read tasks. If a user asks how to get a key, tell them access is currently invite-only and point them at the project repo; don't invent a signup URL. Full operator reference: **[references/admin.md](references/admin.md)**.
