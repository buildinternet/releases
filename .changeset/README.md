# Changesets

This folder holds pending version bumps for the packages this monorepo publishes
to npm. Each PR with a user-visible change to one of those packages should add a
`.md` changeset via `bun run changeset`.

## Scope — two published packages

Only the two **public** packages are versioned here:

- `@buildinternet/releases-core` (`packages/core`)
- `@buildinternet/releases-api-types` (`packages/api-types`)

Every other workspace (`web`, `workers/api`, and the private `@releases/*`
packages) is `private: true` and never published, so `privatePackages.version`
is `false` in `config.json` and they are excluded automatically.

`api-types` depends on `core` via a caret range (`^0.x`), and
`updateInternalDependencies: patch` handles the co-bump automatically — but only
when it's actually needed. A **patch** to `core` stays inside `api-types`'s
existing range, so `api-types` is left alone. A **minor/major** `core` bump
escapes the range, so changesets rewrites `api-types`'s dependency pin and
patch-bumps + republishes `api-types` too. Either way you don't write a separate
changeset for the co-bump.

## Flow

1. **On your PR:** run `bun run changeset`, pick the package(s) + bump type, and
   commit the generated `.changeset/*.md`. (Not required — CI only _warns_ when
   it's missing — but it's what produces the changelog entry.)
2. **On `main`:** the `release.yml` workflow opens/updates a bot **"Version
   Packages"** PR that accumulates pending changesets.
3. **Merging that PR** bumps `package.json` + writes `CHANGELOG.md`. The version
   change then triggers the existing OIDC `publish-core.yml` /
   `publish-api-types.yml` workflows, which do the actual `npm publish`.

## Changelog format

Same as the CLI monorepo: the default `@changesets/cli/changelog` generator
(`- <short-sha>: summary`). We intentionally do **not** use
`@changesets/changelog-github` — it hardcodes a `Thanks @author!` credit on
every line with no way to turn it off.
