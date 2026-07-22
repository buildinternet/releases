# Transactional email

Every message the platform sends renders through one shell:
`renderEmail(doc)` from `@releases/rendering/email-shell`. Callers describe a
message as blocks and get back a matched pair of bodies — table-based HTML with
inline styles, and the plain-text alternative saying the same thing in the same
order. No sender hand-rolls markup.

## Lanes

| Lane     | Messages                                                                                                                                                                 | Tone                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Account  | verify, magic link, password reset, email change, workspace invitation, submission ack                                                                                   | accent                                   |
| Reader   | daily + weekly follow digest                                                                                                                                             | accent                                   |
| Operator | cron report, staleness digest, recommendation, CLI feedback, and the `[alert]` family (cron crash, poll-and-fetch, search no-results, webhook DLQ, webhook auto-disable) | `warn` when degraded, `crit` when failed |

The lane label sits in the masthead; the tone colors the 3px rule at the top of
the message (azure / amber / red), so severity reads before the subject does.

## Design constraints

The palette mirrors the `.org-surface` tokens in
`packages/design-system/src/tokens.css`; the accent is the app icon's third bar
(`oklch(0.60 0.18 252)`), flattened to `#0081e7` because email clients don't
parse `oklch()`. Beyond that, the shell exists to hold five rules that are easy
to break one message at a time:

- **Inline styles, `<table>` layout, no web fonts.** There is no cascade to rely
  on and Outlook's Word renderer has no flex or grid. Font stacks quote with
  apostrophes — a `"` inside `style="…"` closes the attribute and silently
  unstyles the rest of the element.
- **No remote images in the chrome.** The mark is drawn with
  background-colored cells and the wordmark is monospaced text, so the identity
  survives image blocking with nothing to load. Org avatars in a digest are the
  one exception: they are content, and they degrade to the name beside them.
- **Every button is followed by its URL as selectable text,** in both parts. A
  blocked button must still be a completable action.
- **Every footer states why the message arrived,** then links to where that can
  be changed (preferences, unsubscribe, admin), then the brand line. Digest mail
  additionally carries RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post`
  headers for inbox-level one-click unsubscribe.
- **Release content is markdown.** Titles and summaries arrive with `**bold**`,
  backticks, and links; `inlineMarkdownToHtml` promotes the inline syntax to
  tags for the HTML part and `stripMarkdown` flattens it for the text part
  (`@releases/rendering/strip-markdown`). Escaping it verbatim shows readers
  asterisks.

## Subject lines

A subject earns its place by naming the thing it concerns. Counts alone ("2
sources overdue", "3 messages") read identically every day and force a click to
learn whether the message applies to you, so every subject that has an entity to
name uses `subjectNames()` — first one or two, then `+N more`, duplicates
collapsed and blanks dropped:

| Message           | Subject                                                                                |
| ----------------- | -------------------------------------------------------------------------------------- |
| digest            | `Releases digest — Cloudflare, Anthropic +2 more · 7 updates · Jul 21`                 |
| poll-and-fetch    | `[alert] poll-and-fetch: Vercel — Next.js +1 more failed (2 sources, scheduledTime=…)` |
| staleness         | `[staleness] 4 sources overdue: Vercel, Acme +2 more`                                  |
| cron report       | `[degraded] scrape-agent-sweep: degraded — 2/4 dispatched → 1 inserted (Example Co)`   |
| webhook DLQ       | `[alert] webhook DLQ: 3 messages — Acme Inc`                                           |
| search no-results | `[alert] search no-results: 24.0% zero-hit (29/120) — "sample zero hit" +1 more`       |

A healthy cron run names nobody — there is no affected entity and the counts are
the whole story. Operator subjects keep their `[alert]` / `[feedback]` prefixes
(operators filter on them) and carry no dates; the inbox timestamp already does.
Account mail carries the fact the reader needs instead: the new address on an
email change, the expiry when it is short, the domain they submitted.

## Gmail annotations

Messages with an action carry schema.org JSON-LD
([Gmail markup](https://developers.google.com/workspace/gmail/markup)):

- **Go-To Action** (`ViewAction`) — a button beside the subject in the inbox
  list. Used by every account email, and by the digest.
- **One-Click Action** (`ConfirmAction` + `HttpActionHandler`) — Gmail POSTs
  from the inbox and the reader never opens the message. Used only by email
  verification, handled by `POST /v1/email-actions/verify-email`, which replays
  the token through Better Auth's own verify endpoint (one code path owns token
  consumption and expiry). The route is anonymous by design — the emailed token
  is the whole credential, exactly as in the link — opaque 404 on anything
  unknown, and idempotent because Google may retry. It rate-limits itself
  **inside the handler** against `AUTH_RATE_LIMITER`, the same per-IP edge
  limiter that fronts `POST /api/auth/*`, because it consumes a real auth
  credential.

Anonymous write lanes are a standing trap here: `publicRateLimitMiddleware`
returns early on non-safe methods, so mounting it over a POST route throttles
nothing while reading as protection. Two shapes are correct — an
auth-credential endpoint limits in-handler against `AUTH_RATE_LIMITER` (tight,
brute-force posture), and everything else opts the tiered limiter into unsafe
methods: `publicRateLimit({ unsafeMethods: true })`, as
`POST /v1/digest/unsubscribe/:token` now does.

Both annotations stay inert until the sending domain is
[registered with Google](https://developers.google.com/workspace/gmail/markup/registering-with-google)
and passes DKIM/SPF/DMARC. **That registration is still outstanding** — the
markup ships correct and dormant.

## Previewing

`/admin/emails` renders and test-sends every message from
`EMAIL_SAMPLE_CATALOG` (`workers/api/src/lib/email-samples.ts`). Adding a
message means adding a sample there; the catalog is what makes the whole surface
reviewable in one place.

The two webhook alerts are rendered by their real formatters, which live in
`@releases/core-internal/webhook-alert-format` precisely so both the webhooks
worker and this preview can import them. They were briefly rebuilt by hand here
under a "keep this in step" comment and drifted within a single PR — different
lane, different blocks, different footer — so the preview stopped showing what
operators receive. A shared implementation is the only version of that promise
that holds.
