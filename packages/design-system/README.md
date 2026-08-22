# @releases/design-system

Releases design system — the token + component vocabulary behind the web app, packaged for reuse and for claude.ai/design sync.

## Exports

Imported as `@releases/design-system` (and `/styles.css`, `/tokens.css`).

| Subpath      | Purpose                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `.`          | Component + token index: class-string primitives, token reference cards, and the component library (Button, Input, Card, …). |
| `styles.css` | Compiled Tailwind v4 CSS (tokens + utilities + self-hosted JetBrains Mono), generated into `dist/`.                          |
| `tokens.css` | The source token stylesheet.                                                                                                 |

Run `node build.mjs` (or `bun run build`) to produce `dist/` — it compiles the ESM bundle, the Tailwind CSS, and per-component `.d.ts` files, and copies the referenced font weights.

**Private, workspace-only — not published to npm.**

## What lives where

- **Look** (tokens, class strings, thin wrappers) — this package. Buttons, inputs, cards, list rows, eyebrows. Feature UI styles with these constants rather than inventing another `inputClass`.
- **Overlay behavior** (popover, select, dialog) — `web/src/components/ui`, Base UI primitives restyled onto the house stone tokens. New floating UI (filter menus, confirms, selects) uses those primitives. Do not add another `pointerdown` + Escape menu.
