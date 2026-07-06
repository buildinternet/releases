# Submit fast lane — web `/submit` two-lane page + CLI validate (#1947 phase 3 / #1910)

Front-door surfaces for the self-serve listing lane. The backend (`POST /v1/listing/validate`
and `POST /v1/listing/activate`, #1967) and wire types (`@buildinternet/releases-api-types`
0.39.0, #1971) are already live; this phase adds the consumers: the web `/submit` fast lane
and a CLI validate verb. Prior art: integrations.sh's activation loop (publish the file,
get instant feedback, listing goes live) — adapted to our two-rung model where activation
creates a stub and live tracking is a separate curator-gated rung.

## Decisions made during brainstorming

- **One front door:** extend `/submit` into a two-lane page rather than adding a dedicated
  `/listing/verify` page. The validate step doubles as a manifest checker for already-listed
  domains on the same page.
- **No `requestTracking` control in the UI.** Every activation sends `requestTracking: true`.
  Whether tracking actually happens is curator discretion via the `GET /v1/orgs?trackingRequested=1`
  queue; the UI states this plainly instead of pretending it is a user choice.
- **CLI scope is validate-only.** `releases listing validate <domain>` — read-only, the
  terminal/CI iterate loop. Activation stays web-only for now (no anonymous write verb in
  the CLI this phase).

## Web: `/submit` two-lane page

Files: `web/src/app/submit/page.tsx` (edit), `web/src/app/submit/listing-fast-lane.tsx` (new).
The existing `submit-source-form.tsx` is untouched.

**Layout.** The page keeps its shell (sidebar + content panel). The content section becomes
two lanes:

1. **Fast lane (primary, top):** "Have a `releases.json`? Enter your domain."
2. **Recommendation form (below, under a divider):** "No manifest? Suggest a changelog URL
   instead" — the existing `SubmitSourceForm`.

Sidebar copy updates to lead with the fast lane; the existing "Own your listing" block and
`/docs/listing` link remain.

**Fast lane component** — one client component, three states:

1. **Input.** Single domain field + "Check my listing" button. Client-side normalization of
   paste noise (strip scheme, path, trailing slash) before POSTing
   `/v1/listing/validate { domain }` via the existing web API-client pattern.
2. **Result** (rendered from `ListingValidationResult`):
   - _Invalid_ → error list from `errors[]`: `path` in mono, `message` in prose; link to
     `/docs/listing`; a re-check button for the iterate loop.
   - _Valid + `domainStatus: "unlisted"`_ → preview card: identity (name, slug, domain),
     `products[]` with location counts, and a locations table (locator, `kind` chip, the
     server-provided `becomes` string). Per-row tier from `classification`:
     `tier1-live` renders as "goes live", `tier2-paused-review` as "reviewed first" —
     existing chip styling, no emojis. Below the preview: **Activate listing**.
   - _Valid + `"listed"` or `"stub"`_ → same validation/preview feedback (manifest-checker
     use case), but the activate button is replaced with "This domain is already listed"
     plus a link to `result.org.webUrl`.
3. **Activated.** POST `/v1/listing/activate { domain, requestTracking: true }` (always).
   Success state: org name + status, link to the new org page (`org.webUrl`), and the line
   "Your listing is live as a catalog entry. Live release tracking is enabled after a
   curator review." The `activated: false` carve-out (re-activating an existing stub)
   renders the same success framing without the "created" wording.

**Error handling.** Non-2xx responses use the standard nested envelope; render
`error.message` inline (web inlines the envelope decode — the api-types barrel cannot be
runtime-imported in the Next bundle). 429 (per-IP 10/min on validate, per-domain 3/min on
activate) and the `listing-self-serve-enabled` kill-switch 400 both land through this path.
Network failure → generic inline retry message.

## CLI: `releases listing validate <domain>`

Repo: releases-cli (out-of-tree). A read-only top-level verb (the writes-live-under-admin
convention applies to mutations; this is a read-shaped check).

- POSTs `{apiUrl}/v1/listing/validate { domain }`, no auth required.
- Renders: valid/invalid headline; on invalid, the `errors[]` list with paths; on valid,
  identity, products, and the locations preview in table form (locator, kind,
  classification, becomes).
- Points to `https://releases.sh/submit` for activation.
- Uses `@buildinternet/releases-api-types` ^0.39.0 shapes.
- Ships with a changeset targeting `@buildinternet/releases`.

## Testing

- **Web:** follow existing component test patterns if present for form components;
  otherwise verify the three states against the local dev API (`dev:web` + `dev:api`)
  with a real manifest domain and an invalid one.
- **CLI:** mocked-fetch command test per existing CLI test conventions (test base
  `https://test.example.com` — `getApiUrl()` memoizes).

## Non-goals

- No auth or signed-in variants; the lane is anonymous by design.
- No manifest editor or file upload — the manifest lives on the owner's domain.
- No changes to the recommendation form or its API.
- No new API surface; both consumers ride the shipped phase-2 endpoints unchanged.
- No CLI `activate` verb this phase.
- Stub org-page SEO posture (`noindex`) is out of scope — it belongs to the org-page
  rendering work, not the submit flow.
