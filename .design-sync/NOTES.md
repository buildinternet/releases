# design-sync notes — @releases/design-system

Repo-specific gotchas for future `/design-sync` runs of this package. Read before re-syncing.

## What this package is

A NEW workspace package (`packages/design-system/`, `@releases/design-system`, global `window.ReleasesDS`) that **productizes** the web app's design vocabulary into real React components for claude.ai/design. It is **Phase 1** of a phased plan — the web app (`web/`) does **not** consume it yet; migrating `web/src` to import from it is a separate, later step. The Claude Design project is **"Releases"** (`projectId` in config.json).

## How the components were built (and the main drift risk)

- The class-string constants in `src/classes.ts` are a **verbatim copy** of `web/src/components/account/ui.tsx`'s exported class strings (`primaryButtonClass`, `inputClass`, `cardClass`, `eyebrowClass`, …). The `src/styles.css` tokens are copied from `web/src/app/globals.css` (the `:root` brand block + the `.org-surface` palette).
- **Drift risk:** these are COPIES, not imports. If `account/ui.tsx` class strings or `globals.css` tokens change in the app, re-sync `src/classes.ts` / `src/styles.css` by hand. Nothing enforces parity automatically.
- Settings/feedback/theme/data components are faithful ports of real app components (`account/ui.tsx`, `account/settings-section.tsx`, `theme-provider.tsx`, `theme-toggle.tsx`, `sparkline.tsx`). The `Foundations` group (BrandColors/ProductPalette/SurfaceTokens/Typography/Radius) are token _reference_ cards authored for this package (no app counterpart).

## Build

- `cfg.buildCmd = node packages/design-system/build.mjs` — a self-contained build: esbuild → `dist/index.es.js` (React external), Tailwind v4 CLI → `dist/styles.css`, `tsc` → `.d.ts`, and copies JetBrains Mono woff2 (from `@fontsource/jetbrains-mono`) → `dist/fonts/`. **Re-run it before the converter** whenever `src/` changes.
- Build deps live in an **isolated** `packages/design-system/node_modules`, installed with `npm install --no-workspaces --no-package-lock` (run from the package dir) — deliberately NOT a root `bun install`, to avoid churning the repo lockfile during a sync. There is **no lockfile** for these build deps; a future install could drift esbuild/tailwind/typescript versions. Add one if reproducibility bites.
- Converter invocation (from repo root):
  `node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules packages/design-system/node_modules --entry ./packages/design-system/dist/index.es.js --out ./ds-bundle`

## Render check / chromium (macOS)

- Playwright's browser cache on macOS is `~/Library/Caches/ms-playwright` (NOT the Linux `~/.cache/ms-playwright`). chromium-1228 is cached; `playwright@1.61.1` (installed into `.ds-sync/`) pins that build, so the render check + capture run with **no download**. On another machine, install a `playwright` whose `browsers.json` pins a cached chromium build.

## Config specifics (why each non-obvious key exists)

- `provider: ThemeProvider` + `componentSrcMap.ThemeProvider: null` — `ThemeProvider` is the preview wrapper (so `ThemeToggle` renders in context) and is excluded from cards (it only renders children). It stays in the bundle as the provider.
- **Grouping** is by `@category <Group>` JSDoc tags placed immediately above each `export function`. Multi-export files (`Foundations.tsx`, `Banners.tsx`, `List.tsx`, `SettingsSection.tsx`) need a `componentSrcMap` pin per export so the converter src-matches them. **Adding a component to one of those files → add its `@category` tag AND a `componentSrcMap` pin**, or it falls back to group "general".
- `overrides`: `PanelGrid`/`Aside` set `viewport: 1100x760` because they use the Tailwind `lg:` (1024px) breakpoint — the default 900px capture viewport hides the aside/second column. 12 wide components use `cardMode: column` (the `[GRID_OVERFLOW]` fix; their previews are wider than a grid cell).

## Previews

- Authored previews (`.design-sync/previews/*.tsx`) use **inline styles** for layout glue and the real components for the DS parts. This is deliberate: the shipped `styles.css`/`_ds_bundle.css` carry only the utilities the components + class constants actually use — it is **not** a full Tailwind build, so arbitrary utility classes in a preview won't resolve. Style glue with `style={{…}}`.
- Preview content is illustrative Releases-domain copy (Vercel/Stripe/Next.js, API keys, digests) — no upstream tie; safe to keep.
- 5 Foundations components have no authored preview (they self-render their token content) — they ride as floor cards and render real content; not a defect.

## Known render warns

None outstanding. After the column-mode + viewport overrides, validate exits clean with 0 warnings.

## Re-sync risks (what can silently go stale)

- **classes.ts / styles.css vs the app** — the biggest one. They're hand-copied from `account/ui.tsx` + `globals.css`; an app change there silently desyncs the design system. Re-check on any account-UI/token change.
- **No build lockfile** — `npm install --no-package-lock` means esbuild/tailwind/tsc versions can drift between machines/runs. Output is deterministic given the same versions; pin a lockfile if a rebuild ever differs.
- **chromium pin** — tied to the local Playwright cache (build 1228 / playwright 1.61.1). A fresh machine needs a matching install.
- **Phase 2 (app adoption) not done** — if/when `web/src` migrates to import `@releases/design-system`, the copy-vs-import drift risk above goes away; until then, keep them in sync manually.
