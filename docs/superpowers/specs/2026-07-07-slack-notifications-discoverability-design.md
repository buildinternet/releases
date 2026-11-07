# Slack notifications discoverability — design

**Date:** 2026-07-07
**Status:** Approved, ready for planning

## Problem

Slack support already exists but is undiscoverable. Today it is only a `format: "slack"`
option inside the generic webhooks form: **Settings → Webhooks & API → Add webhook →
open the Format dropdown → "Slack message"**. The word "Slack" appears nowhere until that
dropdown is opened. The `/account/notifications` page — where users expect notification
destinations to live — has no mention of it at all. The only Slack documentation is a
buried "Slack delivery" subsection under **API → Webhooks**.

Under the hood a "Slack notification" is just a user webhook whose `url` is a
`hooks.slack.com` (or `hooks.slack-gov.com`) incoming-webhook URL and whose `format` is
`"slack"`. There is no OAuth "Add to Slack" app — the incoming-webhook URL is the secret.

## Goal

Make Slack notifications discoverable through two surfaces, both driving to the same
existing feature. No backend, api-types, or new lib changes — this is a web-only,
additive change reusing `@/lib/webhooks`.

1. An inline **Slack** section on `/account/notifications`.
2. A dedicated, friendly **docs page** at `/docs/integrations/slack`.

## Non-goals

- No first-class OAuth Slack app / "Add to Slack" button.
- No new API endpoints, api-types shapes, or `webhooks.ts` lib functions.
- No changes to org-scoped webhooks, release-type filters, or JSON format — those stay on
  `/account/webhooks`. The inline section links out for them.
- No new feature flag (per repo convention: ship enabled; nothing risky/expensive here).

## Relevant existing code

- `web/src/components/notifications-panel.tsx` — the `/account/notifications` panel. Two
  sections today: `EmailSection` (digest) and `FeedTokenSection` (personal feed token),
  stacked in `NotificationsPanel` inside a `PanelGrid` (`flex flex-col gap-9`). Signed-out
  users see a sign-in prompt.
- `web/src/lib/webhooks.ts` — browser client for `/v1/me/webhooks`. Reuse as-is:
  `listWebhooks()`, `createWebhook({ url, scope, format })`, `testWebhook(id)`,
  `deleteWebhook(id)`. `UserWebhookFormat` is `"json" | "slack"`.
- `web/src/components/webhooks-panel.tsx` — full webhooks form. Key constraint at
  lines 180–182: **only one `follows`-scope webhook total is allowed**
  (`canCreateFollows = !hasFollows`), regardless of format. Create call shape mirrored at
  lines 210–223. Slack URL host allow-list is enforced by the backend
  (`hooks.slack.com`, `hooks.slack-gov.com`).
- `web/src/content/docs/api/webhooks.md` — has a "## Slack delivery" subsection (the only
  current Slack doc).
- `web/src/lib/docs-manifest.ts` — ordered `ENTRIES` array is the single source of truth
  for docs sidebar/sections/llms.txt/raw-md routes. Docs page = markdown file + route
  wrapper + manifest entry.
- `web/src/app/docs/api/webhooks/page.tsx` — the ~10-line `MarkdownDoc` route wrapper
  pattern to copy.

## Deliverable 1 — inline Slack section on `/account/notifications`

Add a `SlackSection` component in `notifications-panel.tsx` (same file, same visual
language as the other sections), rendered in `NotificationsPanel` after `FeedTokenSection`.
It covers the **`follows` scope only**.

### Behavior

**On mount:** call `listWebhooks()`. From the result derive:

- `slackHooks` = webhooks with `format === "slack"` (the destinations to display).
- `hasFollowsWebhook` = any webhook with `scope === "follows"` (any format) — mirrors the
  backend's single-follows-slot rule.

**Rendering states:**

1. **No follows webhook yet (slot free), no Slack hook** — empty state:
   - Intro copy: "Send new releases to Slack — a message posts to your channel whenever
     something you follow ships." + link "How to get a Slack webhook URL →" to
     `/docs/integrations/slack`.
   - One text input, placeholder `https://hooks.slack.com/services/…`, plus a **Create**
     button.
   - **Client-side host validation before submit:** reject unless the URL parses and its
     host is `hooks.slack.com` or `hooks.slack-gov.com` — friendly inline error
     ("Enter a Slack incoming webhook URL (hooks.slack.com)."). This mirrors the backend
     allow-list so users get a fast error instead of a round-trip failure.
   - On submit: `createWebhook({ url: url.trim(), scope: "follows", format: "slack" })`,
     then re-run `listWebhooks()` to refresh into the connected state. Show a success line
     ("Slack connected.").

2. **A Slack follows webhook exists** — connected state:
   - Show the destination as a row (reuse `listCardClass`/`listRowClass`). Display a
     non-secret label for the destination (e.g. the row's `description` if present, else a
     generic "Slack channel" — do NOT render the full secret URL).
   - **Test** button → `testWebhook(id)` (surface success/failure inline).
   - **Remove** button → `deleteWebhook(id)` behind a `window.confirm`, then refresh.

3. **Follows slot taken by a non-Slack webhook** — fallback (no inline create):
   - Short note: "You already have a follows webhook. Manage it — or switch it to Slack —
     in Webhooks & API." + link to `/account/webhooks`.

**Always, at the bottom of the section:** an "Advanced" link — "Need org-specific alerts,
filters, or the JSON payload? Advanced options →" → `/account/webhooks`.

### Constraints / conventions

- Reuse `@/lib/webhooks` functions only; no new lib code, no new endpoints.
- Reuse design-system primitives already imported in the file
  (`listCardClass`, `listRowClass`, `ErrorText`, button classes, etc.).
- No emojis in the UI (repo convention) — use text/icon components.
- Local `busy`/`error`/`success` state per the existing section patterns; optimistic UI is
  not required here.
- Signed-out handling is already covered by `NotificationsPanel`'s guard; `SlackSection`
  only renders for signed-in users.

## Deliverable 2 — docs page `/docs/integrations/slack`

1. **Markdown:** `web/src/content/docs/integrations/slack.md` with frontmatter
   `title` + `description`. A friendly walkthrough:
   - Create a Slack incoming webhook (link to Slack's app/incoming-webhooks config).
   - Paste the URL on the notifications page (link to `/account/notifications`); note the
     one-click inline setup.
   - What the delivered message looks like.
   - Security note: Slack webhooks are unsigned — the URL is the secret; keep it private,
     rotate by deleting + recreating.
   - Testing (the Test button).
   - Supported hosts: `hooks.slack.com`, `hooks.slack-gov.com`.
   - Pointer to `/account/webhooks` for org-scoped alerts, filters, and JSON format.
2. **Route:** `web/src/app/docs/integrations/slack/page.tsx` — copy the `api/webhooks`
   wrapper: `const SLUG = "integrations/slack"; generateMetadata = () =>
   docPageMetadata(SLUG); export default … <MarkdownDoc slug={SLUG} />`.
3. **Manifest:** add `{ slug: "integrations/slack", section: "Integrations", label:
   "Slack" }` to `ENTRIES` in `docs-manifest.ts`. Place the new **Integrations** section in
   a sensible order (proposed: after "For Owners", before "CLI").

## Cross-links

- `web/src/content/docs/api/webhooks.md` "Slack delivery" subsection → add a line pointing
  to `/docs/integrations/slack` as the friendlier setup guide.
- `web/src/components/webhooks-panel.tsx` Format help text (the Slack option help around
  line 550) → link "Slack message" help to `/docs/integrations/slack`.
- The new notifications `SlackSection` intro → links to `/docs/integrations/slack`.

## Testing / verification

- Type-check + lint: `bun run check` (run `./scripts/setup-worktree.sh` first in this
  worktree so `node_modules` resolves).
- Manual/preview verification of `/account/notifications`:
  - empty → create with a valid `hooks.slack.com` URL → connected state.
  - invalid host → inline validation error, no network call.
  - Test and Remove actions on the connected row.
  - non-Slack follows webhook present → fallback link state.
- Docs: `/docs/integrations/slack` renders, appears in the sidebar under Integrations, and
  `/docs/integrations/slack.md` raw route resolves.

## Risks / edge cases

- **Single follows-slot rule.** Handled by the three-state rendering; the fallback state
  prevents a confusing 4xx when the slot is already taken by a JSON webhook.
- **Secret URL exposure.** The connected row must not render the full Slack URL (it is the
  secret). Show a non-secret label only.
- **Client validation drift.** The client host check duplicates the backend allow-list; if
  the backend list changes, update both. Kept intentionally minimal (host equality only).
