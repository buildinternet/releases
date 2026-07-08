# Slack Notifications Discoverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Slack release notifications discoverable via an inline Slack section on `/account/notifications` and a dedicated `/docs/integrations/slack` page, both driving the existing `format:"slack"` user-webhook feature.

**Architecture:** Web-only, additive. A new `SlackSection` in `notifications-panel.tsx` reuses `@/lib/webhooks` (`listWebhooks`/`createWebhook`/`testWebhook`/`deleteWebhook`) to manage a single `follows`-scope Slack webhook inline. A new content-markdown docs page + route wrapper + manifest entry adds an "Integrations → Slack" doc. Cross-links tie the surfaces together. No backend, api-types, or lib changes.

**Tech Stack:** Next.js (App Router) + React client components, TypeScript strict, Tailwind, `@releases/design-system` primitives, Bun.

## Global Constraints

- Reuse `@/lib/webhooks` only — no new API endpoints, api-types shapes, or lib functions.
- Only **one `follows`-scope webhook total** is allowed per user (any format); the UI must handle the slot being free / taken-by-Slack / taken-by-non-Slack.
- The Slack incoming-webhook URL is a **secret** — never render the full URL in the connected row; show a non-secret label only.
- Client-side host allow-list must match the backend: `hooks.slack.com` and `hooks.slack-gov.com` only.
- **No emojis** in web UI (repo convention) — text or icon components only.
- No new feature flag (ship enabled).
- Worktree bootstrap: run `./scripts/setup-worktree.sh` before type-checking so `node_modules` resolves.
- Verification gate for web TS: `bun run check` (oxlint + typecheck + format). Tests are not part of `check`.
- Docs pages require three coupled edits: markdown file + route wrapper + `docs-manifest.ts` entry.

---

### Task 1: Docs page — `/docs/integrations/slack`

**Files:**
- Create: `web/src/content/docs/integrations/slack.md`
- Create: `web/src/app/docs/integrations/slack/page.tsx`
- Modify: `web/src/lib/docs-manifest.ts` (add entry to `ENTRIES`, after the `listing` "For Owners" line, before the `cli/browsing` "CLI" line)

**Interfaces:**
- Consumes: `MarkdownDoc` (`@/components/markdown-doc`), `docPageMetadata` (`@/lib/doc-metadata`), the `ENTRIES` array shape `{ slug, section, label }`.
- Produces: docs slug `integrations/slack`, nav section `"Integrations"` — referenced by Task 3's cross-links and Task 2's intro link.

- [ ] **Step 1: Create the markdown content**

Create `web/src/content/docs/integrations/slack.md`:

```markdown
---
title: Send releases to Slack
description: Post new releases to a Slack channel whenever something you follow ships.
---

# Send releases to Slack

Get a Slack message every time an org or product you follow ships a release. No app to
install — you paste a Slack **incoming webhook URL** and releases.sh posts to it.

## 1. Create a Slack incoming webhook

In Slack, create an [incoming webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)
for the channel you want releases posted to. Slack gives you a URL that looks like
`https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXX`.

## 2. Connect it on releases.sh

Open [Notifications](/account/notifications), find the **Slack** section, paste the webhook
URL, and click **Create**. That's it — you'll get a Slack message for everything you follow.

Use the **Test** button to post a sample message and confirm the channel is wired up.

## What the message looks like

Each release is posted as a compact Slack message: a linked title, a short summary, and a
context line with the organization's avatar and date.

## Keep the URL private

Slack webhooks are **unsigned** — the URL itself is the secret. No signing key is issued and
no signature headers are sent. Treat the URL like a password. To rotate it, remove the Slack
connection and create a new one with a fresh URL.

## Supported hosts

The URL host must be `hooks.slack.com` (standard and Enterprise Grid) or `hooks.slack-gov.com`
(GovSlack). Other hosts are rejected.

## Need more control?

For org-specific alerts, release-type filters, or the raw signed JSON payload, use
[Webhooks &amp; API](/account/webhooks).
```

- [ ] **Step 2: Create the route wrapper**

Create `web/src/app/docs/integrations/slack/page.tsx` (mirrors `web/src/app/docs/api/webhooks/page.tsx`):

```tsx
import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "integrations/slack";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function SlackIntegrationDocsPage() {
  return <MarkdownDoc slug={SLUG} />;
}
```

- [ ] **Step 3: Register in the docs manifest**

In `web/src/lib/docs-manifest.ts`, add the Integrations section to `ENTRIES` between the
`listing` line and the `cli/browsing` line:

```ts
  { slug: "listing", section: "For Owners", label: "Get Listed" },

  { slug: "integrations/slack", section: "Integrations", label: "Slack" },

  { slug: "cli/browsing", section: "CLI", label: "Browsing & Search" },
```

- [ ] **Step 4: Type-check and verify the docs build resolves**

Run: `./scripts/setup-worktree.sh && bun run check`
Expected: PASS (no type or lint errors). The manifest hydrates `integrations/slack` at module load; a missing markdown file would throw, so a clean `check` confirms the file resolves.

- [ ] **Step 5: Commit**

```bash
git add web/src/content/docs/integrations/slack.md web/src/app/docs/integrations/slack/page.tsx web/src/lib/docs-manifest.ts
git commit -m "docs(web): add Integrations > Slack setup page"
```

---

### Task 2: Inline Slack section on `/account/notifications`

**Files:**
- Modify: `web/src/components/notifications-panel.tsx` (add `SlackSection`, render it in `NotificationsPanel`)

**Interfaces:**
- Consumes: `listWebhooks`, `createWebhook`, `testWebhook`, `deleteWebhook` from `@/lib/webhooks`; `UserWebhookListItem` type; design-system classes already imported in the file plus `smallButtonClass`, `secondaryButtonClass`, `dangerLinkClass`, `ErrorText`, `listCardClass`, `listRowClass`; docs slug `integrations/slack` from Task 1.
- Produces: `SlackSection` React component rendered inside `NotificationsPanel`.

- [ ] **Step 1: Add imports**

At the top of `web/src/components/notifications-panel.tsx`, add the webhooks lib import
(after the existing `@/lib/follows` import) and the type:

```tsx
import {
  listWebhooks,
  createWebhook,
  testWebhook,
  deleteWebhook,
  type UserWebhookListItem,
} from "@/lib/webhooks";
```

The design-system imports (`listCardClass`, `listRowClass`, `ErrorText`,
`secondaryButtonClass`, `smallButtonClass`, `dangerLinkClass`) are already present in the
existing import block — reuse them.

- [ ] **Step 2: Add the `SlackSection` component**

Add this component in `web/src/components/notifications-panel.tsx`, after `FeedTokenSection`
and before `NotificationsPanel`:

```tsx
const SLACK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);

function isSlackWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" && SLACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function slackRowLabel(hook: UserWebhookListItem): string {
  return hook.description?.trim() || "Slack channel";
}

function SlackSection() {
  const [hooks, setHooks] = useState<UserWebhookListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function refresh() {
    setHooks(await listWebhooks());
  }

  useEffect(() => {
    listWebhooks()
      .then(setHooks)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load Slack settings."),
      )
      .finally(() => setLoading(false));
  }, []);

  const slackHook = hooks.find((h) => h.format === "slack" && h.scope === "follows") ?? null;
  const followsTakenByOther = !slackHook && hooks.some((h) => h.scope === "follows");

  async function onCreate() {
    if (busy) return;
    if (!isSlackWebhookUrl(url)) {
      setError("Enter a Slack incoming webhook URL (hooks.slack.com).");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await createWebhook({ url: url.trim(), scope: "follows", format: "slack" });
      setUrl("");
      setSuccess("Slack connected.");
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to connect Slack.");
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    if (!slackHook || busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await testWebhook(slackHook.id);
      setSuccess("Sent a test message to Slack.");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to send test message.");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    if (!slackHook || busy) return;
    if (!window.confirm("Remove this Slack connection? Releases will stop posting to it."))
      return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await deleteWebhook(slackHook.id);
      setSuccess(null);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to remove Slack connection.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;

  return (
    <section>
      <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">Slack</div>
      <p className="mt-1 mb-3.5 text-[13px] text-stone-500 dark:text-stone-400">
        Post a message to a Slack channel whenever something you follow ships.{" "}
        <Link
          href="/docs/integrations/slack"
          className="underline underline-offset-2 hover:text-stone-900 dark:hover:text-stone-100"
        >
          How to get a Slack webhook URL
        </Link>
      </p>
      {error && (
        <div className="mb-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {success && (
        <p className="mb-3 text-[12.5px] text-[var(--accent)]">{success}</p>
      )}

      {slackHook ? (
        <div className={listCardClass}>
          <div className={listRowClass}>
            <div className="flex-1">
              <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                {slackRowLabel(slackHook)}
              </div>
              <div className="mt-0.5 text-[12.5px] text-stone-400 dark:text-stone-500">
                Connected — receiving everything you follow.
              </div>
            </div>
            <div className="flex shrink-0 gap-3 text-[13px]">
              <button
                type="button"
                onClick={() => void onTest()}
                disabled={busy}
                className="text-stone-500 hover:text-stone-900 disabled:opacity-50 dark:text-stone-400 dark:hover:text-stone-100"
              >
                Test
              </button>
              <button
                type="button"
                onClick={() => void onRemove()}
                disabled={busy}
                className={dangerLinkClass}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : followsTakenByOther ? (
        <p className="text-[13px] text-stone-500 dark:text-stone-400">
          You already have a follows webhook. Manage it — or switch it to Slack — in{" "}
          <Link
            href="/account/webhooks"
            className="underline underline-offset-2 hover:text-stone-900 dark:hover:text-stone-100"
          >
            Webhooks &amp; API
          </Link>
          .
        </p>
      ) : (
        <div className="flex items-center gap-2.5">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://hooks.slack.com/services/…"
            className="h-10 min-w-0 flex-1 rounded-[9px] border border-stone-200 bg-white px-3 font-mono text-[12.5px] text-stone-700 placeholder:text-stone-400 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-200"
          />
          <button
            type="button"
            onClick={() => void onCreate()}
            disabled={busy || !url.trim()}
            className={`${smallButtonClass} h-10 shrink-0`}
          >
            {busy ? "Connecting…" : "Create"}
          </button>
        </div>
      )}

      <p className="mt-2.5 text-[12.5px] text-stone-400 dark:text-stone-500">
        Need org-specific alerts, filters, or the JSON payload?{" "}
        <Link
          href="/account/webhooks"
          className="underline underline-offset-2 hover:text-stone-700 dark:hover:text-stone-300"
        >
          Advanced options
        </Link>
      </p>
    </section>
  );
}
```

- [ ] **Step 3: Render `SlackSection` in `NotificationsPanel`**

In `NotificationsPanel`'s returned `PanelGrid`, add `<SlackSection />` after `<FeedTokenSection />`:

```tsx
      <div className="flex flex-col gap-9">
        <EmailSection />
        <FeedTokenSection />
        <SlackSection />
      </div>
```

- [ ] **Step 4: Type-check and lint**

Run: `bun run check`
Expected: PASS. Confirms `UserWebhookListItem` has `format`, `scope`, `id`, and `description` fields as used (they are part of the api-types shape already consumed by `webhooks-panel.tsx`).

- [ ] **Step 5: Preview-verify the four states**

Start the web dev server and open `/account/notifications` (signed in). Confirm:
- Empty (no follows webhook): input + Create; pasting a non-`hooks.slack.com` URL and clicking Create shows the inline validation error with no network request; a valid URL creates and flips to the connected row.
- Connected: Test posts a sample (success line), Remove (after confirm) returns to empty state.
- With a pre-existing non-Slack follows webhook: the fallback "Webhooks & API" link renders instead of the input.

Use the preview tools (`preview_start`, `preview_snapshot`, `preview_screenshot`) rather than asking the user to check manually.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/notifications-panel.tsx
git commit -m "feat(web): inline Slack notifications section on the notifications page"
```

---

### Task 3: Cross-links from webhooks doc and webhooks panel

**Files:**
- Modify: `web/src/content/docs/api/webhooks.md` (Slack delivery subsection, ~line 111-125)
- Modify: `web/src/components/webhooks-panel.tsx` (Slack format help text, ~line 549-554)

**Interfaces:**
- Consumes: docs slug `integrations/slack` from Task 1.
- Produces: no new interface; wiring only.

- [ ] **Step 1: Point the webhooks doc at the friendly guide**

In `web/src/content/docs/api/webhooks.md`, under the `## Slack delivery` heading, insert a
lead-in line immediately after the heading (before the existing `Set \`format: "slack"\`…`
paragraph):

```markdown
## Slack delivery

New to this? The [Send releases to Slack](/docs/integrations/slack) guide walks through it
step by step. The reference below covers the API/CLI details.

Set `format: "slack"` (or `--format slack` on the CLI) and point the subscription
```

(Leave the rest of the paragraph and section unchanged.)

- [ ] **Step 2: Link the panel's Slack help text**

In `web/src/components/webhooks-panel.tsx`, update the `format === "slack"` help paragraph
(lines ~549-554) to link to the docs page. It currently reads:

```tsx
          {format === "slack" && (
            <p className="mt-1 text-[11px] text-stone-400 dark:text-stone-500">
              Posts a formatted message to a Slack incoming webhook URL (hooks.slack.com). No
              signature is sent.
            </p>
          )}
```

Replace with (keeps the copy, adds a Setup guide link — `Link` is already imported in this file):

```tsx
          {format === "slack" && (
            <p className="mt-1 text-[11px] text-stone-400 dark:text-stone-500">
              Posts a formatted message to a Slack incoming webhook URL (hooks.slack.com). No
              signature is sent.{" "}
              <Link href="/docs/integrations/slack" className="underline underline-offset-2">
                Setup guide
              </Link>
            </p>
          )}
```

- [ ] **Step 3: Type-check and lint**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/content/docs/api/webhooks.md web/src/components/webhooks-panel.tsx
git commit -m "docs(web): cross-link Slack setup guide from webhooks doc and panel"
```

---

## Self-Review

**Spec coverage:**
- Inline Slack section (follows-only, 4 states, host validation, secret-safe label, advanced link) → Task 2. ✓
- Docs page + route + manifest Integrations section → Task 1. ✓
- Cross-links (webhooks.md, webhooks-panel help text, notifications intro) → Task 3 + Task 2 Step 2 intro link. ✓
- No backend/api-types/lib changes → all tasks touch only `web/src` content/components/manifest. ✓
- Single-follows-slot handling → `slackHook` / `followsTakenByOther` branches in Task 2. ✓
- Secret URL never rendered → `slackRowLabel` shows description or "Slack channel". ✓
- Client host allow-list matches backend → `SLACK_HOSTS` set. ✓
- No emojis, no feature flag → satisfied. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/vague steps — all code shown in full.

**Type consistency:** `UserWebhookListItem` fields used (`id`, `format`, `scope`, `description`) match the type consumed by `webhooks-panel.tsx`; `createWebhook`/`testWebhook`/`deleteWebhook`/`listWebhooks` signatures match `web/src/lib/webhooks.ts`. Docs slug `integrations/slack` used identically in Tasks 1–3.
