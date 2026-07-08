# @releases/design-system

Releases design system — the token + component vocabulary behind the web app, packaged for reuse and for claude.ai/design sync.

## Exports

- `@releases/design-system` — component and token index: class-string vocabulary primitives, token reference cards (colors, palette, surfaces, typography, radius), and the component library (Button, Input, Card, etc.).
- `@releases/design-system/styles.css` — compiled Tailwind v4 CSS (tokens + utilities + self-hosted JetBrains Mono), generated into `dist/` by `build.mjs`.
- `@releases/design-system/tokens.css` — the source token stylesheet.

Run `node build.mjs` (or `bun run build`) to produce `dist/` — it compiles the ESM bundle, the Tailwind CSS, and per-component `.d.ts` files, and copies the referenced font weights.

**Private, workspace-only — imported via `@releases/design-system`, not published to npm.**
