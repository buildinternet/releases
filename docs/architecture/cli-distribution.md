# CLI Distribution

The CLI is published from the public OSS repo at [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli) — not from this monorepo. That repo owns `@buildinternet/releases{,-darwin-*,-linux-*}` on npm, the GitHub Release binaries, and the Homebrew tap (`buildinternet/homebrew-tap`).

Shared npm packages are split by where they're published from:

- **`@buildinternet/releases-core`** — published from this monorepo (`packages/core/`). DB schema + pure runtime-neutral helpers. Consumed here via `workspace:*`; the OSS CLI pulls the published version from npm.
- **`@buildinternet/releases-lib`** and **`@buildinternet/releases-skills`** — published from the OSS CLI repo, consumed here as regular npm deps (pinned versions in `package.json`).
- **`@releases/core-internal`** — private workspace (`packages/core-internal/`) for DB-coupled / worker-only helpers the thin OSS CLI doesn't need: `release-upsert`, `hash`, `webhook-sign`.

**If a schema change needs to ship to the CLI:** edit `packages/core/src/schema.ts` here, publish a new `@buildinternet/releases-core` version, then bump the pin in the OSS CLI repo.

**If a CLI-only change needs to ship:** land it in `buildinternet/releases-cli`, run `bun run changeset` there, and merge. The OSS repo's own workflow handles the version PR + publish.

The monorepo does not carry CLI binary scaffolds or Homebrew releases — if you see those in an old PR, don't restore them.
