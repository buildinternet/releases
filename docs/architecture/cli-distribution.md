# CLI Distribution

The CLI is published from the public OSS repo at [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli) — not from this monorepo. That repo owns `@buildinternet/releases{,-darwin-*,-linux-*}` on npm, the GitHub Release binaries, and the Homebrew tap (`buildinternet/homebrew-tap`).

This monorepo consumes the published packages (`@buildinternet/releases-core`, `-lib`, `-skills`) like any other npm dependency. It does not carry `npm/*` scaffolds, Changesets config, or a `Release CLI` workflow anymore — if you see those in an old PR, don't restore them.

**If a CLI change needs to ship:** land it in `buildinternet/releases-cli`, run `bun run changeset` there, and merge. The OSS repo's own workflow handles the version PR + publish. Shared code used by workers (e.g. `packages/core`, `packages/lib`) can still be edited here, but the published copies live in the OSS repo — monorepo edits to those packages are dev-only until mirrored.
