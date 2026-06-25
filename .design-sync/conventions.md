# Releases design system

Build with the real Releases components, exported on `window.ReleasesDS` (e.g. `window.ReleasesDS.Button`). The look is a small set of CSS custom-property **tokens** plus the warm-**stone** neutral palette. Use the vocabulary below and every design stays on-brand and maps 1:1 onto the app's code.

## Setup

- **Import the stylesheet once at the root.** It defines the brand tokens, declares the org-surface tokens, and self-hosts JetBrains Mono (the mono "eyebrow" face). Without it, components render unstyled.
- **Wrap the tree in `<ThemeProvider>`** for light/dark. Dark mode is driven by a `.dark` class on a parent (the provider manages it); every component already ships its `dark:` variants. Static light-mode work renders without it, but include it for theme-aware UI and to use `<ThemeToggle>`.

```jsx
const { ThemeProvider, SettingsSection, Card, Label, Input, Button } = window.ReleasesDS;

<ThemeProvider>
  <SettingsSection group="Account" title="Profile" description="Shown on your public profile.">
    <Card>
      <div
        style={{ display: "flex", flexDirection: "column", gap: 16, padding: 20, maxWidth: 440 }}
      >
        <div>
          <Label>Display name</Label>
          <Input defaultValue="Acme Inc" />
        </div>
        <Button variant="primary">Save changes</Button>
      </div>
    </Card>
  </SettingsSection>
</ThemeProvider>;
```

## The styling idiom

**Compose the components first.** For anything they don't cover, the design language is reachable three ways — in order of preference:

1. **Exported class-string constants** (also on `window.ReleasesDS`) — ready-made class strings for styling a raw element consistently, e.g. an `<a className={window.ReleasesDS.primaryButtonClass}>`: `primaryButtonClass`, `secondaryButtonClass`, `smallButtonClass`, `smallPrimaryButtonClass`, `dangerLinkClass`, `confirmRemoveButtonClass`, `inputClass`, `textareaClass`, `fieldLabelClass`, `cardClass`, `listCardClass`, `listRowClass`, `eyebrowClass`, `orgEyebrowClass`.
2. **Brand tokens** as CSS custom properties — apply via inline style (`style={{ background: "var(--accent)" }}`) or an arbitrary class (`bg-[var(--accent)]`):

   | Token                                     | Role                                                     |
   | ----------------------------------------- | -------------------------------------------------------- |
   | `--accent`                                | brand blue — primary buttons, links, active nav, toggles |
   | `--accent-soft`                           | low-alpha accent wash — active / preview backgrounds     |
   | `--on-accent`                             | text/icon color on an accent fill (white)                |
   | `--color-product-0` … `--color-product-7` | the 8-color product palette (charts)                     |

   **Org-surface neutrals** are semantic tokens that resolve **only inside an element with the `org-surface` class** — wrap the surface in `<div className="org-surface">…</div>`: `--page`, `--surface`, `--surface-2`, `--fg`, `--fg-2`, `--fg-3`, `--line`, `--line-2`, `--field`, and status `--good` (green) / `--fix` (amber).

3. **Inline styles** for one-off layout glue (flex / gap / padding / width).

**Neutrals** everywhere else are Tailwind's **warm `stone`** palette (`stone-200` borders, `stone-900`/`stone-100` text, `stone-50`/`stone-950` page) — never cool `gray`/`slate`. **Type:** body is the system sans; the uppercase mono kicker ("eyebrow") is `font-mono text-[11px] uppercase tracking-[0.16em]`.

> The shipped stylesheet carries the tokens and the utilities these components and constants use — it is **not** a full Tailwind build. So prefer the components and the class constants above; don't invent arbitrary utility classes and expect them to resolve.

## Components, by group

- **Foundations** (BrandColors, ProductPalette, SurfaceTokens, Typography, Radius) — token _reference_ cards. Read them to see the palette; don't place them in app UI.
- **Actions** — `Button` (`variant`: primary / secondary / danger / confirm; `size`: md / sm).
- **Forms** — `Input`, `Textarea`, `Label`, `Toggle` (controlled: `checked` + `onChange`).
- **Layout** — `Card`, `ListCard` + `ListRow` (a divided list), `Eyebrow` (`tone`: default / accent), `Aside` (sticky context rail, lg+), `SettingsSection` (panel header) + `PanelGrid` (main column + optional `aside`).
- **Feedback** — `PreviewBanner` (accent-soft "coming soon"), `SuccessBanner` (green), `ErrorText` (red inline).
- **Data** — `Sparkline` (`data: number[]`, `id`).
- **Theme** — `ThemeProvider`, `ThemeToggle`.

## Where the truth lives

Read the bound `styles.css` (and its imports) for exact token values, and each component's `.prompt.md` for its props and examples. The real components are the source of truth — compose them, don't reimplement.
