# Changelog

The product changelog for releases.sh, published to its own registry. Drafted daily from merged
PRs and reviewed via PR. See docs/changelog-style.md for the voice and curation rules.

## July 13, 2026

**Added**
- Blume changelogs — sites built on the Blume self-hosted Astro changelog generator are now auto-detected and ingested via their native RSS feed.
- AI-scored importance now reaches collection and category timelines, the following feed, live stream, search results, related rails, and MCP `search` results; a hover card on the flame glyph explains the 4 vs. 5 score.
- Collection weekly digests available as Markdown, JSON, and Atom — `.md`, `.json`, and `.atom` format adapters on the digest index; individual week pages support `.md` and `.json`.
- Recent digests surface in the collection right rail with a browse-all link; digest pages now include an AI-generated content disclaimer.

**Fixed**
- Collection digest pages polished — headings render at the correct depth, a covered-orgs facepile shows which companies are featured, breadcrumbs link back to the digest archive, and prev/next cards navigate between weeks.
- Geist Pixel wordmark now uses the variable font at true weight 400 — the faux-bold smear from stacked bold utilities is gone.

## July 12, 2026

**Changed**
- Site wordmark and entity page titles (org and product names) now render in Geist Pixel; the same branded treatment appears on social-share OG images.

## July 11, 2026

**Added**
- Weekly collection digests — AI-written weekly summaries for curated collections, published at `/collections/[slug]/digest/[week]`; browse past digests at `/collections/[slug]/digest`; `GET /v1/collections/:slug/digests` and `GET /v1/collections/:slug/digests/:weekStart` expose the list and detail via the REST API; each digest links to the releases it covers, grouped by org.
- Release sitemap — `GET /v1/sitemap/releases` surfaces importance-gated releases (importance ≥ 3 with an AI summary) for search engine indexing; `sitemap-releases.xml` is now declared in `robots.txt`.

**Changed**
- Release pages now show a labeled divider between the AI summary and the original release note — a "From the original release note" section header with an inline "View original ↗" link makes the two-source layout explicit; the lede is suppressed when the body isn't meaningfully longer than the summary.
- Web interface polish — buttons now have press-scale feedback on click; release thumbnails in tickers and org teasers display a consistent image outline; the homepage agent use-cases copy has been rewritten in plainer language.

## July 10, 2026

**Added**
- Release importance scoring (1–5) — all newly ingested releases receive an AI-scored significance rating; a flame glyph marks high-impact (4) and landmark (5) releases on feed cards and detail pages; `GET /v1/releases/latest` gains a `?minImportance=` filter; MCP `get_latest_releases` and `whats_changed` expose a matching parameter.
- `/updates` redesigned with a timeline rail and composition glyphs — month rows and area chips (CLI / Web) filter the feed client-side; per-release meta lines render composition counts as filled, half, and dash glyphs; Follow, Digest, and Atom links appear in the page header.
- Category and collection scoping for search — `GET /v1/search` now accepts `?category=<slug>` and `?collection=<slug>` to narrow results to a taxonomy category or a curated collection's member orgs.
- Wider catalog and collection layouts with an export rail — `/catalog` and `/collections` expand to a wider shell; the collections index uses a two-column grid; collection detail pages gain a sticky rail with Export (`.json` / `.md` / `.atom`) and a Report a problem button.

**Changed**
- Digest emails and collection daily summaries now bias toward higher-importance releases — within each org section in digests and when selecting releases for collection date tiles, items with a higher importance score surface first.

**Fixed**
- Digest emails now capture releases ingested after the check window opened — editorial posts published hours before being fetched were previously dropped permanently; the email subject is also now dated for the window it covers rather than the delivery day.
- Inline code spans no longer stripped in compact org overview cards — tool names and verdict values that rendered as stray punctuation now appear correctly.

## July 9, 2026

**Added**
- Homepage features an interactive CLI preview — job-led tabs demo live commands and responses, with a live vitals strip showing indexed source and release counts.
- Compact release cards now show a media thumbnail when the release has associated imagery.
- Org rows in the catalog and search results now display provenance — origin domain, alias badge, and a stub icon for listings awaiting verification.
- Digest emails redesigned for scannability — releases grouped by org with compact multi-release blocks and clearer visual hierarchy.
- In-place release re-fetch: `POST /v1/workflows/refetch-release` re-fetches a single release's live page and updates its title, content, and date in place without changing its ID.
- `GET /v1/lookups/by-domain` now auto-materializes a listing stub on miss when the domain has a valid `releases.json` manifest, returning a 200 instead of 404.

**Changed**
- Release pages now use a shared org-level OG card across all releases from that org, instead of rendering a per-release image.
- `/v1/search` release hits no longer include full markdown content by default; pass `?include_content=true` to opt in.

**Fixed**
- Org and product catalog pages now fall back to REST when GraphQL is unavailable during deploy windows, rather than showing an error state.
- Root-relative per-post permalinks (e.g. `/blog/post`) now resolve correctly during extraction.
- `GET /v1/orgs/:slug` now resolves by the org's primary domain, fixing lookups that previously returned 404.

## July 8, 2026

**Added**
- `GET /v1/orgs/:slug/manifest` — export any tracked org as a `releases.json` v2 domain manifest; reconstructs declared products, source locators, and canonical flags from live registry data; intended as an editable baseline to host at `/.well-known/releases.json`.
- `creating-releases-json` Claude Code skill — an agent-guided flow for writing a `releases.json` v2 manifest from your domain or repo; install via `npx skills add` from the monorepo; the `/submit` page now shows a click-to-copy install command alongside the listing check.
- "Report an issue" button on org, product, source, and release pages — opens a contextual popover to send a short note to operators without leaving the page.

**Changed**
- The `/submit` listing check now previews richer details for valid manifests — org identity (name, slug), products with per-product source counts, and a table of detected release locations with kind chips and tier badges.

**Fixed**
- MCP `get_organization` now measures overview age from the last-edit timestamp instead of the original generation date — recently amended overviews no longer appear falsely stale.

## July 7, 2026

**Added**
- Domain ownership claims — a new "Own this domain?" panel on listing pages lets signed-in users prove control via a `.well-known/releases-verify.txt` file or a DNS TXT record; once verified, a single click enables live release tracking and materializes sources without waiting for curator review.
- Slack notifications are now a first-class setup path — a new guide at `/docs/integrations/slack` walks through connecting a Slack incoming webhook, and the notifications page gains a dedicated section to paste, test, and remove a hook without going into the advanced webhooks form.
- Unlisted domains that are frequently searched now auto-create stub listings — domain lookup misses are captured as demand signals and a daily sweep probes high-demand unlisted domains for a `releases.json` manifest, creating stubs automatically.

**Changed**
- Anonymous API reads are now served from Cloudflare Workers Cache — a global tiered cache rather than per-datacenter, so catalog, org, and search responses warm once and hit worldwide.

**Fixed**
- Auth sessions are no longer cached — a Workers Cache heuristic was letting `GET /api/auth/get-session` responses land in the shared cache, causing signed-in users to appear signed out for up to two hours.
- Admin-gated and authorization-required API responses are no longer stored in shared cache — a gap where write-scoped and admin responses could be served to anonymous callers has been closed.

## July 6, 2026

**Added**
- Self-serve listing on `/submit` — enter your domain to validate your `releases.json` manifest and activate listing immediately; valid manifests show a plain-language preview of detected release locations with an activate button for unlisted domains; invalid manifests display field-level errors with a re-check loop. New `POST /v1/listing/validate` and `POST /v1/listing/activate` endpoints support the same flow for API and agent callers.

**Changed**
- Changelog pages load faster — `/changelog` routes now render markdown server-side; shiki and react-markdown no longer ship to the browser on these pages.

## July 5, 2026

**Added**
- Stub organizations appear in the registry catalog — orgs known from a `releases.json` manifest but not yet ingested are listed with a stub badge; `GET /v1/orgs/:slug` and the domain-lookup endpoint return their declared source locations; MCP `get_organization` and `lookup_domain` surface stub status and declared release locations instead of an empty sources list.

**Changed**
- Org overview citation style rebuilt — the Sources section now links to release pages on releases.sh rather than placing inline superscripts; cited sources link inward to the canonical release URL when available and carry `CreativeWork` JSON-LD for SEO; the fenced-JSON citation format is retired.

**Fixed**
- Raw JSON citation blocks no longer appear in org overviews — a generation-truncation edge case was leaking an unterminated JSON code block into the overview body; affected overviews have been repaired.
- Emoji sprites and CI-status badges no longer appear in newly indexed release media — the media pipeline now filters WordPress emoji sprites and CI badge URLs before mirroring.

## July 4, 2026

**Added**
- Release URLs now include a human-readable slug — links look like `/release/rel_...-whats-new-in-v2` instead of bare IDs; old bare-ID links redirect permanently. The slugged canonical URL is now carried through MCP tool outputs, Atom feeds, webhook payloads, Slack cards, and digest emails.
- `releases.json` v2 manifest — declare where your release notes live at `/.well-known/releases.json`; the registry auto-creates sources from `feed`, `github`, and `appstore` locators and reconciles product metadata, tags, and identity fields without overwriting curator edits.
- Docs pages now support deep links and show an "On this page" rail — all `/docs/` section headings have stable anchor IDs, authored cross-section links resolve correctly, and a scrolling sidebar highlights the active section.
- Mobile app discovery from platform link files — iOS apps are auto-discovered from `/.well-known/apple-app-site-association` and queued as paused candidates for curator review; no bespoke manifest required.

**Changed**
- Org overviews now adapt to release velocity — active orgs refresh on a 2-day cycle with a 30-day activity window; quiet orgs use a 90-day fallback; per-org cadence overrides are supported.
- Collection, category, and release-list pages load faster — markdown is now rendered server-side; shiki and react-markdown no longer ship to the browser on list views.

**Fixed**
- Product rows in org overview panels now link to their product pages.
- Hidden sources no longer appear on public org, product, or search pages — a filtering gap in release feeds, source rows, and organization search results has been corrected.

## July 3, 2026

**Added**
- Release cards now show a "Breaking" severity badge — releases classified as breaking changes display the severity level on feed cards, org pages, and search results; the detail page gains a migration notes block when notes are present. The `breaking` and `migrationNotes` fields are now returned on all release read API endpoints and search results.
- releases.sh is now listed on integrations.sh — the REST API, MCP server, and CLI are declared as integration surfaces with auth instructions; `/openapi.json` on releases.sh proxies the live OpenAPI 3.1 spec, and the MCP server card now includes a connect URL for integration scanners.

**Changed**
- MCP `get_release` and `search` tool calls now serve cached results, and the latest-releases edge cache is flushed on publish — faster repeated MCP reads and new releases appear in feeds immediately without waiting for a cache TTL.

## July 2, 2026

**Fixed**
- Clicking into a release or org from the feed now scrolls to the top of the page — a Next.js 16 routing change had caused page transitions to land partway down the destination.
- Source submission form now shows the specific rejection reason instead of a generic error — rate-limited, oversized, and service-unavailable responses each display their correct message.

## July 1, 2026

**Changed**
- Discovery agents and search queries now use Claude Sonnet 5 — higher-quality changelog extraction and keyword search across the registry.
- Webhook delivery activity now shows the delivery format — the account notifications panel displays whether each webhook was sent as Slack or standard JSON.
- New orgs added to the registry now have AI content generation enabled by default — overviews and summaries start generating automatically for freshly curated orgs.

## June 30, 2026

**Added**
- Settings Webhooks & API panel now has a click-to-copy install command — tap the MCP or CLI card to copy its setup command, with manual card navigation between them.

**Changed**
- Disabled placeholder controls removed from active settings pages — Bio on Profile, Instant release alerts on Notifications, and Default visibility on General no longer appear in the live UI.
- Org overviews now regenerate weekly for active orgs (was every two weeks) — orgs with recent release activity get fresher summaries more often.
- API and MCP reads are now cached for anonymous traffic — most catalog, org, and collection endpoints serve from a worker-level cache on repeat requests; nine MCP read tools (latest releases, catalog, orgs, collections, and others) additionally cache results.

**Fixed**
- Settings right-hand rail now renders as a side column on wide screens — the panel was appearing as a footer block below the main content.

## June 29, 2026

**Changed**
- Sign-in, sign-up, forgot-password, and reset-password pages unified — all authentication screens now share the centered card layout introduced with the OAuth and device flows, with consistent typography, button styles, and dark-mode support.

## June 25, 2026

**Added**
- User and workspace avatar uploads — upload a photo from Account → Profile (user avatar) or Account → General (workspace avatar); avatars appear in the account menu, settings sidebar, and workspace switcher. Workspace General also adds editable company website, changelog URL, and GitHub handle fields.

**Changed**
- Account settings rebuilt with a new design — a two-pane layout with a grouped sidebar, workspace selector, and individually-addressable pages for Profile, Security, Notifications, General, and Webhooks & API; the header account dropdown gains a workspace switcher with switch and create actions.
- Org pages redesigned — wider layout with a new header, "Copy for agent" split-button (agent prompt / page link / Markdown), product tiles with sparklines and cadence indicators in the Overview, "By product" chips in Releases, sources grouped by product with type badges in Sources, an About / Export context rail, and a dot indicator that lights when releases ship after your last visit.
- OAuth and device authorization flow redesigned — consent, device-code entry, and device-approval screens now share a centered card layout with a connection visual, collapsible permission groups, and full dark-mode support.

**Fixed**
- Org page mobile layout restored — headers, tabs, release rows, and install commands wrap correctly on narrow screens after the redesign introduced overflow.
- Account settings copy corrected — MCP install command, Homebrew tap URL, and workspace profile descriptions now match the real commands and routes.

## June 24, 2026

**Added**
- Slack delivery format for webhooks — set `format: "slack"` on a subscription and point it at an incoming-webhook URL to receive releases as Slack Block Kit cards; the default HMAC-signed JSON delivery path is unchanged.
- Workspaces now support member and invitation management — invite teammates by email, toggle member/admin roles, remove or leave a workspace, and accept or decline invitations from the emailed link.

**Changed**
- Digest email subjects now include the covered date — daily digests show "Jun 24, 2026" and weekly digests show "week of Jun 17, 2026" alongside the update count, making threads easier to find in your inbox.

## June 23, 2026

**Changed**
- CLI reference docs at releases.sh now document `--page-all` streaming output, `--fields` field projection, `--input` JSON payloads, and `--dry-run` for write commands; the stale "Summaries & Comparisons" page documenting removed commands has been removed.

## June 22, 2026

**Changed**
- Web frontend polish sweep — stat counts in the homepage hero use tabular digits to prevent layout shift; headings and summaries use balanced line-breaking; image borders are now neutral instead of tinted; interactive controls across the site (follow, load-more, copy, theme toggle, lightbox) respond with a subtle scale-on-press; copy and theme-switch icons cross-fade instead of hard-swapping.

## June 21, 2026

**Changed**
- Digest email delivery and webhook release fan-out are now queue-backed — each recipient gets an independent retry budget so a transient failure no longer silently drops messages.

## June 20, 2026

**Added**
- `whats_changed` MCP tool and `GET /v1/whats-changed` API endpoint — given a package name and `from`/`to` versions, returns the changelog entries in that range with per-release breaking-change verdicts (`none` / `minor` / `major`) and migration notes; SDK, tool, and platform releases now receive automated breaking-change classification at ingest so results are immediately available.

## June 19, 2026

**Added**
- Self-serve webhook management — create, list, update, and delete subscriptions from Account → Notifications with org-scoped or follows-scoped targeting, per-event product and release-type filters, delivery activity history, and auto-pause on repeated failures with an owner email alert when a subscription is paused.

**Changed**
- Feed rows with multiple image attachments now display a compact bottom gallery of chips; single-attachment rows keep the existing side-rail preview.
- Following feed now renders immediately on page load — the first page is server-prefetched and cached (~90 s TTL) so the timeline appears without a client-side loading flash.
- Personalized feed API (`GET /v1/me/feed`) switched to cursor pagination; the `?page=` parameter is rejected with 400.

**Fixed**
- Product and source bylines no longer display version labels for codename-versioned releases — only numeric semver/calver strings appear; model codenames (e.g. "Opus 4.7") are omitted.

## June 18, 2026

**Added**
- Account settings rebuilt with a two-column layout and individually-addressable pages — profile, email, security, connections, notifications, and API keys each get their own URL; a sidebar link shortcuts to your Following feed.
- Source suggestions that include a contact email now receive an acknowledgment.
- Bulk release management API — `DELETE /v1/releases/batch` and `POST /v1/releases/batch-suppress` delete or toggle suppression for a list of releases in one call.

**Changed**
- Org overview pages now show enriched product chips — cadence badge, sparkline, windowed release count, weekly average, and latest version synced to the timeline brush — replacing the per-source card lists.
- Follow and admin controls repositioned into the title row on org and product pages; follow button is larger and pill-shaped; page layouts widened.

**Fixed**
- Collection daily summaries now incorporate actual changelog text — SDK version-tag releases (e.g. `wrangler@4.101.0`) now produce a meaningful description instead of echoing the version string.
- "Get Started" install steps on the homepage no longer show agent-launcher dropdown menus; copy-to-clipboard remains.

## June 17, 2026

**Fixed**
- Digest emails now include real release notes in SDK version-tag rollups — the most substantive tags render as `version — one-liner` with a "+N more" overflow link; pure dependency-bump entries are ranked out.

## June 16, 2026

**Added**
- "Get Listed" docs page at `releases.sh/docs/listing` — explains how changelog owners declare their source via `releases.json` or `.well-known/releases.json`, with examples, the honored fields, and fill-if-empty / curator-protected rules. The JSON schema for editor autocompletion is served at `releases.sh/schemas/releases.json`.

**Fixed**
- Social preview cards now appear on org sub-pages (releases, sources), product and source changelogs, highlights, source detail pages, and standalone pages (catalog, categories, submit) that were previously missing `og:image`.
- Docs and legal pages now have correct heading structure — the page title renders as `<h1>` instead of `<h2>`; `og:url` and `og:type` are also filled in across these pages.
- The JSON Schema URL at `releases.sh/schemas/releases.json` now resolves — a routing rule was incorrectly intercepting `.json` paths under `/schemas/` and returning 404.

## June 15, 2026

**Added**
- Signed-in admin users can now access the full admin surface in production — inline edit menus on orgs, sources, products, and releases; the Status dashboard; and Fetch Log and Playbook tabs on org pages. Previously only available in local development.

**Changed**
- The /live feed now shows rich release cards: org avatar and name, source and product identity, descriptive AI title with version tag, two-line summary, and inline media or video preview.
- Feed and collection surfaces now serve AI-generated excerpts instead of the full release body; the complete text stays on the canonical release detail page.

**Fixed**
- Google Sign-In and One Tap now correctly store the original-cased display email address rather than the dot-stripped lowercase form.

## June 14, 2026

**Added**
- Collection daily summaries — AI-generated headline, one-line summary, and bullet takeaways now appear as a date header above each day's releases on collection pages.
- Account settings now let you change your email address (a confirmation link goes to your current address) and connect or disconnect linked social sign-in accounts.

**Changed**
- Collection timeline rebuilt: same-product releases in a day collapse into a single grouped card; release cards lead with descriptive AI titles instead of raw version strings; "Show more" appears only when content actually overflows.

**Fixed**
- RSS feeds that deliver raw markdown in `content:encoded` now parse correctly — headings, code spans, and links are preserved instead of being backslash-escaped into plain text.
- Release pages with no content now show a placeholder instead of a blank body.
- Long CLI and MCP install commands now wrap instead of clipping in the copy-to-clipboard inputs.
- The sign-in form on incompatible origins (e.g., preview-deploy URLs) now explains why authentication won't work and links to the canonical site.

## June 13, 2026

**Added**
- Passkey sign-in — use Face ID, Touch ID, or a hardware security key to authenticate. Manage, rename, and remove passkeys from the account settings page.

**Fixed**
- Relative links in ingested release notes (e.g. `/docs`, `./changelog`) now resolve against the vendor's domain when rendered — no more broken in-page navigation.
- Coverage-side release URLs now redirect to the canonical release page instead of returning 404.

## June 12, 2026

**Added**
- "What agents ask" section on the homepage — three example prompts showing what the platform answers for agents tracking their stack, ecosystem integrations, and industry trends.

**Changed**
- Homepage refreshes: the org table now has a "Featured" heading; the hero release count displays in compact form (35.6k-style); signed-out visitors see a signup link under the CLI demo.
- Status removed from the top navigation — it remains accessible via the Admin dropdown.

**Fixed**
- Coverage siblings in the "N other posts cover this launch" rail no longer link to suppressed pages that return 404 — they render as plain, non-linked rows.

## June 11, 2026

**Added**
- Site-wide notices — admins can post a banner or homepage card with a configurable color and an optional dismiss button.
- Avatar facepile previews on category pages and collection search results — up to three member logos so you can recognize what's inside at a glance.

**Changed**
- Search entity matching now uses word boundaries and relevance ranking — searching "ai" shows AI-focused orgs and products, not every `.ai` TLD. The web search page adds a capped "All" tab with per-section "show all →" links, URL-synced tabs (`?filter=`), and word-boundary highlights. The MCP `search` tool now uses the same matching logic.

**Fixed**
- Source fetch now auto-generates AI titles and summaries for newly-inserted releases in the same request, without waiting for the next cron run.
- Release detail API responses are now stale for at most ~90 seconds (down from ~3 minutes).

## June 10, 2026

**Added**
- `/updates` — releases.sh now publishes its own product changelog at releases.sh/updates, with daily entries and per-day permalink pages going back to March.
- API key last-used time — the account page now shows when each read-only API key was last used, or marks it as never used, making it easy to spot stale keys before revoking them.

## June 9, 2026

**Added**
- Daily and weekly digest emails for the organizations and products you follow.
- Inline video cards — Loom, Wistia, Vimeo, and YouTube links in release notes now render as play-thumbnails.

**Changed**
- Clearer visuals and hierarchy for organization, product, and collection results in search.
- Version-tagged releases now collapse into a tidy per-product rollup on your Following feed and in digests.

## June 8, 2026

**Added**
- Follow organizations and products, and get a personalized feed of everything they ship.
- Subscribe to that feed over RSS/Atom with a private feed token.
- Manage who you follow from the CLI and the MCP server.

**Changed**
- Release breadcrumbs now show the organization logo and product name.

## June 7, 2026

**Added**
- Sign in with Releases — Releases is now an OAuth/OIDC provider, so other apps and MCP clients can authenticate users through it.

## June 6, 2026

**Fixed**
- Bluesky accounts now appear among an organization's linked social profiles.

## June 5, 2026

**Added**
- `releases login` — sign in from your browser with no copy-paste tokens (device authorization).
- Create read-only API keys for your account from the web dashboard.
- Claim and shape your organization's listing with a `releases.json` file on your own domain.

**Changed**
- Refreshed homepage with an animated backdrop and a search-first CLI demo.

## June 4, 2026

**Added**
- Sign in with Google, including Google One Tap and avatar sync.
- Magic-link passwordless login.

## June 3, 2026

**Added**
- Curators can now post a notice on an organization, product, or source, surfaced as a banner on the page and a pointer in the MCP server.
- Organization and product pages now show a "Featured in" sidebar listing the collections they belong to.

**Changed**
- Heavy animated GIFs now play as efficient MP4 video across release pages, inline notes, thumbnails, and the lightbox, for much faster loading.

## June 2, 2026

**Added**
- GitHub star counts now appear on repository-centric pages.
- A new public status page with health checks for the service.

## June 1, 2026

**Added**
- Add a timeframe filter to the search page to narrow results to a recent window.

**Changed**
- Videos now show a compact presentation on the ticker and search cards.
- Refreshed the home page hero headline and subhead.

**Fixed**
- Search is now live and responsive as you type, with no dropped characters or stale results.
- The MCP server now flags an ambiguous bare source or product slug instead of quietly resolving to the wrong organization.
- Cleaned up the header navigation, made sidebar domains clickable, and fixed the mobile menu stacking.

## May 31, 2026

**Added**
- Release images in feeds now open in a redesigned lightbox that keeps the release in context, with left/right paging between every image.

## May 30, 2026

**Added**
- Browse every tracked organization on a new A-to-Z catalog page, reachable from the header nav.
- The home page now spotlights a curated set of featured organizations.
- Filter releases on an organization feed by time range — last 30 days, 3 months, year, or all time.
- Filter organizations by category in the MCP server's list_organizations tool.

**Changed**
- Aliased category links now resolve to the right category across the web app and MCP server.

## May 29, 2026

**Added**
- Track product-launch videos: YouTube channels and playlists can now be followed as a source, with their launches indexed as releases.
- Releases with video play inline on the release page, with a play badge in feeds.
- A new "Open in [agent]" launcher next to the install commands sets up Cursor, Claude Code, Codex, or VS Code to use releases.sh in one click.
- Try-it-yourself use-case tabs on the home page demo — check product updates, track a company, or search across vendors.
- A new release-composition visualization on detail pages and feeds shows what a release is made of at a glance.

**Changed**
- Same-day App Store versions now roll up into a single entry in the organization feed, and mobile app releases get a more compact presentation across the site.
- SDK and package releases now group into clusters in organization and collection feeds for easier scanning.

## May 28, 2026

**Added**
- Product pages now show their releases directly, in the web app and in the JSON and markdown formats, with a link to the product's Atom feed.
- Search can now be scoped to a single product.
- Ask for a product's releases in the MCP server and get one feed merged across all of its sources.

**Changed**
- Product pages now share the same layout as organization and source pages.
- Release feed rows now lead with a descriptive title and demote the version number.

**Fixed**
- Visiting a product's /changelog URL now lands on the product page instead of a 404.

## May 27, 2026

**Added**
- Product pages are now the default landing and feed unit: a bare /org/product URL resolves to the product hub, complete with its own activity timeline, heatmap, and per-product Atom feed.
- Search results and MCP search hits now show the owning product for each release.
- Owners and curators can rename an organization, product, or source display name directly from the admin menus.

**Changed**
- Mobile app releases now render as a compact app-update row instead of the standard version-and-screenshot layout.

## May 26, 2026

**Added**
- Recommend a new changelog source to index right from the web app.
- Release pages now carry richer structured data and clearer, keyword-aware feed titles for better search-engine and social previews.

**Fixed**
- Release images that previously showed "Image unavailable" now render correctly, as proxied image URLs are unwrapped to the underlying asset.

## May 25, 2026

**Added**
- Track iOS and macOS apps: App Store versions are now indexed as releases, with app icons, platform badges, and an "Available on" affordance on product and source pages.
- MCP release-feed tools now drill from a list into release detail with full, web-parity markdown and inline images.

**Changed**
- Long overview source lists now collapse behind a "Show more" toggle and release thumbnails are downscaled for a tidier layout.

## May 23, 2026

**Changed**
- The "More from this org" and "From other products" rails now show consistent, content-first release cards ranked by recency and quality, dropping stale and empty entries.

## May 22, 2026

**Added**
- Scope search and latest-releases queries to a time window with since and until filters across the API, MCP server, and CLI.
- Send feedback straight from the CLI with the new releases feedback command.
- The home page now leads with an animated terminal demo and a featured-collections promo block.

## May 21, 2026

**Added**
- The org overview and sources pages now fold an organization's SDK sources into one collapsible group so SDK churn no longer crowds out the main changelog.
- Filter releases by kind in the MCP get_latest_releases and list_catalog tools.

**Changed**
- The home page recent ticker shows a roomier three-line byline and syntax-highlighted, click-to-copy install commands.
- Summary-only feed releases are now enriched by following through to the full article, so entries carry real content instead of a teaser.

## May 20, 2026

**Added**
- Mint, list, and revoke scoped, revocable API tokens to authenticate with the API and CLI.
- MCP tools now enforce token scopes, so a read-only token can no longer perform writes.

## May 19, 2026

**Added**
- Classify and filter products and sources by kind — platform, SDK, mobile, desktop, docs, integration, or tool — across the API and MCP server.
- Pin a single product to a collection instead of bringing its whole organization along.

**Changed**
- The catalog, search, and home page now hide organizations with no indexed releases by default, with an opt-in to show them.
- Boilerplate releases with no real content no longer get a misleading auto-generated summary.

## May 18, 2026

**Added**
- Images, GIFs, and videos embedded in GitHub release notes now appear in the release's media.

**Changed**
- Release timelines and collections now load more as you scroll instead of needing a Load more click.
- Search now ranks fresher releases higher, so recent results rise above older ones with similar relevance.
- Release content converted from HTML now renders more reliably, with code blocks and examples preserved.

## May 17, 2026

**Added**
- Releases now show a composition chip summarizing how many fixes, features, and enhancements they contain.

**Fixed**
- Overview citation markers now snap to the end of the cited sentence instead of splitting words, and overviews render fully expanded by default.

## May 15, 2026

**Added**
- Search now lives in the header on every page, and organization avatars appear throughout the homepage.
- Social accounts in the sidebar now show platform icons and link straight to the live profile.
- Feeds now expose each release's content size so agents can decide whether to fetch the full body before spending a round-trip.

**Fixed**
- Fixed duplicate releases appearing in the feed for some RSS-based sources.

## May 14, 2026

**Added**
- Collections now show up in search results across the web, API, MCP server, and CLI.
- Release notes now render GitHub-flavored extras — note/warning callouts, emoji shortcodes, and @user and org/repo#123 autolinks.
- Feed lists show a small +N indicator when a release bundles related coverage from other sources.
- AI summaries now appear as a clearly labeled block above the release body.

**Changed**
- Prereleases like alphas, betas, and RCs are hidden by default, and version ranges render as a clear before-and-after diff.

**Fixed**
- The Latest version and version range now pick the highest semantic version instead of the most recently published, so backported patches no longer masquerade as the newest release.

## May 13, 2026

**Changed**
- Org chip and release-type filters on collection and category timelines now apply across the whole feed, not just the current page.

## May 12, 2026

**Added**
- Browse an interactive, always-current REST API reference at /docs/api/rest.
- MCP clients that support interactive apps now render the latest-releases and collection feeds as a card timeline with Load more.

## May 11, 2026

**Added**
- Browse a new Categories index and per-category rollup pages that aggregate releases across every org and product in a category.
- Org and source pages now live at clean path-based URLs like /org/releases and /org/source/changelog instead of query-string tabs.
- Read why Releases exists on a new introduction page at /docs/why.

**Changed**
- Organization overview sources now render as tidy chips instead of footnotes.
- Categories carry an editable description byline and support alias slugs that redirect to the canonical category.

## May 9, 2026

**Added**
- Organization overviews now show inline citations linking each claim back to the source release.
- AI-generated headlines now appear on release cards across the ticker, feeds, and related rails for clearer at-a-glance summaries.
- Collections, categories, tags, and the live feed now get custom social preview images when shared.

**Changed**
- The homepage ticker is now a swipeable, self-paced carousel of release cards instead of an auto-rotating one.
- Category names now display with proper casing like 'AI' and 'DevOps' across the site.

**Fixed**
- The ⌘K search shortcut works on every page again, and search results now highlight your matched terms.
- Mistakenly future-dated releases no longer get stuck at the top of the homepage and feeds.

## May 8, 2026

**Added**
- Collections are now first-class pages with an editorial timeline, JSON/Atom/Markdown feeds, MCP browsing tools, and discoverable links from organization pages.

**Changed**
- Page navigation now crossfades smoothly, and the homepage install panel is split into clear CLI, MCP, and skill steps.
- Release cards now expand to the full body via 'Show more' on collection pages, matching organization and source views.

**Fixed**
- GitHub CHANGELOG files now keep the newest entries when long, and changelogs in pnpm-workspace repos ingest correctly instead of coming up empty.

## May 7, 2026

**Added**
- Collections — curated, cross-organization release feeds that interleave several companies into one playlist (e.g. Frontier AI Labs).
- Filter any organization's or source's releases with an inline search box, narrow by source type, and look up organizations by their domain.
- Manage what you follow and inspect agent task details directly from the CLI.

**Changed**
- The organization release filter is now a simpler All / Web / GitHub toggle, with prereleases hidden by default.

## May 6, 2026

**Changed**
- Organization pages now lead with 'Last Checked' and a renamed 'Recently Shipped' summary that shows more content by default.

**Fixed**
- Old `/source/:slug` bookmarks and links from the live feed now resolve correctly instead of 404ing.

## May 5, 2026

**Added**
- The homepage now features a Recent releases ticker, with an option to exclude noisy source types.
- Rollup releases now carry a clear badge across the feed, release detail, and search results.
- A machine-readable OpenAPI spec and interactive API docs make the REST API easy to explore.

## May 4, 2026

**Added**
- MCP list tools now support paging through large result sets so big catalogs no longer flood your context window.
- MCP tools, prompts, and resources now accept typed IDs interchangeably with slugs.

**Fixed**
- Search result counts now match the rows shown when your query contains underscores or other special characters.

## May 3, 2026

**Added**
- Browse any organization's sources and products through clean org-scoped URLs, plus a new catalog endpoint for listing everything an org tracks.

## May 2, 2026

**Added**
- Categories and tags are now clickable chips that open dedicated index pages listing every matching organization and product.
- A new Skills page documents how to install and use the Releases skills for your AI agent, with Windows install instructions added too.

**Changed**
- Search is now case-insensitive and understands a `github:` prefix for narrowing to repositories.
- On-demand and admin-hidden sources are now clearly distinguished, with a note explaining why a thin community-sourced listing may have less detail.

**Fixed**
- Coordinate-style searches like `Shopify/toxiproxy` now reliably return the repository you asked for.
- Release titles now link straight to the release page, with larger tap targets on mobile and readable code blocks in light mode.

## May 1, 2026

**Added**
- The live feed of recently indexed releases is now a real, discoverable page, linked from the footer and search engines.

## April 29, 2026

**Added**
- On-demand GitHub repo lookup: searching for an `org/repo` coordinate that isn't indexed yet materializes it on the fly and shows its releases inline, with a "did you mean" rail suggesting known orgs' top sources.

## April 23, 2026

**Added**
- A unified MCP `search` tool that returns organizations, catalog entries (products and sources together), and releases in one call, plus `list_catalog` and `get_catalog_entry` — fewer, simpler tools for AI agents. Older split tools keep working as shims for one release cycle.
- MCP resources, prompts (`whats_new`, `compare_products`, `catch_me_up`), and slug auto-completion, so MCP clients can discover and browse the catalog by typing a prefix.
- A friendly HTML landing page at mcp.releases.sh with a click-to-copy endpoint URL, instead of raw JSON for browsers.
- A `/live` page that streams new releases as they arrive in real time, with an unread-count badge on the tab and favicon when you switch away.
- `/llms.txt` and `/llms-full.txt` endpoints exposing the documentation in agent-friendly form for single-context ingestion.

**Changed**
- Org pages now show the AI-generated overview directly under the activity graph, with a "Show more" clamp so long summaries stay compact.

## April 22, 2026

**Added**
- Canonical URLs and richer structured data (breadcrumbs, organization logos, search box, product pages) across org, product, source, and release pages so search engines resolve and present releases.sh pages better.

**Changed**
- Cleaner related-content rails on source and release pages — two focused scopes ("More from this org" and "From other products") with wider cards, summary previews, and a visual thumbnail instead of four stacked, easily-truncated lists.
- Updated the AI-models timeline overlay on the changelog range navigator with the latest model launches.

## April 21, 2026

**Fixed**
- Brand-new scrape sources now do a full extraction on their first fetch, so they're seeded with all available releases instead of being recorded as having no changes.
- Onboarding a new organization no longer fails when a common source name like "Changelog" is already taken — colliding source slugs are now auto-suffixed.
- The project rename from "Released" to "Releases" is now complete across all user-facing copy, display names, and feed/webhook headers.

## April 20, 2026

**Added**
- Privacy, Terms, and Security pages on releases.sh.
- Every user-facing page now has a markdown representation, so agents can request clean markdown for the homepage, search, status, release, and organization/product pages.
- Organization markdown pages now include a cross-source "Recent Releases" timeline, so agents can see recent activity without drilling into each source.
- High-risk slugs (like `login`, `admin`, `api`) are now reserved, returning a clear error instead of colliding with site routes.

**Changed**
- The sidebar now shows "Last checked" based on the most recent poll, a more accurate signal of when a source was last checked for updates.

**Fixed**
- Content negotiation now honors client preferences correctly — social-image crawlers, sitemap clients, and other non-HTML callers get the asset they asked for instead of an error.
- Organization overviews now appear consistently across the JSON, markdown, and Atom representations, and playbook notes are kept out of the public organization JSON.

## April 19, 2026

**Added**
- Webhooks: subscribe to release events and receive signed deliveries, with CLI commands to add, list, test, and rotate webhook subscriptions, plus a `webhook verify` utility to validate signatures locally.
- Command-K quick search and a new logo on the web frontend, with npm shown as the default install path.
- `--dry-run` and `--max` options when fetching a source, so you can probe what a fetch would pull without writing anything.

**Changed**
- The homepage and install instructions now lead with npm.

**Fixed**
- Very large changelog bodies now extract reliably by streaming, instead of timing out and blocking those sources.

## April 18, 2026

**Added**
- New `tail` command for the latest releases, with `tail -f` to follow new releases live as they're indexed.
- Live release streaming over WebSocket, so tools can subscribe to a real-time feed of new releases instead of polling.
- Browser-side AI agents can now query the registry directly through built-in WebMCP tools (search, list/get organizations, get source, get release) on releases.sh.
- An explicit `--feed-type` override (`rss`/`atom`/`jsonfeed`) on source edit, for feed endpoints whose URL has no file extension to infer from.
- A new version-ladder favicon for releases.sh.

**Changed**
- Latest-releases responses are now cached, so the feed and the CLI load noticeably faster.
- Opt-in pagination envelope on the sources API (`?envelope=true`) returns accurate total counts alongside the items.

**Fixed**
- More resilient feed discovery — dead feeds are now detected and re-checked instead of silently stalling ingestion, and changelogs behind very large pages are now picked up.

## April 17, 2026

**Added**
- Atom 1.0 feeds for every source at `/{vendor}.atom`, so you can subscribe to any tracked changelog in your feed reader.
- The remote MCP server is now published to the public MCP registry, making it discoverable and installable from MCP-aware clients.
- Rich social preview images now generate automatically for organization, product, source, and release pages when shared.
- Release grouping: when one launch is covered by several posts (a marketing announcement plus a changelog entry, say), the related releases are now linked, and release pages show an "also covered by" panel.
- Organization overviews are now surfaced in the CLI and MCP, and overviews are tighter and more focused.
- Markdown-friendly pages for AI agents — request a page with `Accept: text/markdown` to get a clean markdown representation, plus agent-discovery well-known files.

**Changed**
- Read surfaces now show one canonical entry per launch by default instead of duplicate coverage; opt back in with `--include-coverage` (CLI), `?include_coverage=true` (API), or `include_coverage: true` (MCP).
- The docs sidebar navigation now collapses cleanly on mobile.

**Fixed**
- Organization playbook notes are no longer exposed in the public JSON responses.

## April 16, 2026

**Added**
- The CLI now tells you when a newer version is available, with the right upgrade command for how you installed it (npm or Homebrew).
- New `--compact` output and `--limit`/`--page` pagination when listing sources, so large lists are easier to page through and pipe.
- One-step org refresh: re-fetch all of an organization's sources and regenerate its overview in a single command, with `--dry-run`, concurrency, and window controls.
- Server-side search and pagination on the public API — filter organizations and sources by name, slug, or URL with `?q=`, and page results with `?limit`/`?offset`/`?page`.
- A new docs Examples page showing the same command's human-readable table output side-by-side with its `--json` form.

**Changed**
- Latest-releases output now includes a short content preview and media, so you can see what a release is about without opening it.
- AI overviews favor real product changelogs over high-frequency version bumps, so the summary reflects what actually shipped.

**Fixed**
- Renaming a source slug is now guarded behind an explicit confirmation, so you don't silently break existing web links, and bad fields return a clear error instead of a server error.

## April 15, 2026

**Added**
- Hybrid semantic search across releases, organizations/products/sources, and CHANGELOG content — vector search fused with keyword search by default, with keyword-only still available.
- A `--mode` flag on `releases search` to pick lexical, semantic, or hybrid from the terminal.
- Related releases and sources rails on source detail pages, surfacing semantically similar neighbors.
- Token-budgeted changelog slicing — request a chunk by token budget and get back exact token counts, so agents can plan context windows precisely.
- Distinct, deep-linked CHANGELOG search hits on the web that jump you straight to the matching section.
- Anonymous, opt-out usage telemetry for the CLI and MCP server — command names and timing only, never anything you type.

**Changed**
- Redesigned search result cards.
- Drill-down IDs and copy-paste-ready follow-up command hints now appear across `show`, `latest`, `search`, `list`, and fetch-log output.
- Optional per-IP rate limiting is now available for anonymous API reads (off by default; authenticated callers bypass it).

## April 14, 2026

**Added**
- Four new MCP read tools — `get_release`, `get_source`, `list_products`, and `get_product` — bringing the MCP server to parity with the CLI and API.
- A Changelog tab on GitHub-backed source pages that surfaces the repo's canonical `CHANGELOG.md` (including per-package files in monorepos), served via a new `/v1/sources/:slug/changelog` endpoint.
- A changelog range API with heading-aware slicing and progressive loading, so large changelog files load smoothly.
- Public documentation is now live at /docs, with admin-only sections gated out.
- A copyable `npx @buildinternet/releases show <id>` snippet on every source, org, product, and release page so you can pull what you're viewing into your terminal.
- A `/sitemap.xml` (refreshed hourly) covering orgs, products, and sources.

**Changed**
- GitHub sources now display as `@org/repo` with an inline icon instead of a verbose URL.
- The Changelog tab streams in with a skeleton so it swaps instantly even for large files.
- Polished source pages — release thumbnails with an inline image lightbox, compact stats, and a smarter "last fetched" indicator.
- `releases show <org>` now lists the org's 10 most recent releases instead of bare metadata, and `list --json` includes fetch-health fields.

## April 13, 2026

**Added**
- `releases show <id|slug>` — one command that resolves any release, source, org, or product, with forgiving lookups when an ID prefix is dropped.
- Releases are now classified as either individual features or seasonal/quarterly rollups, so big "Fall Release"-style posts model correctly alongside everyday entries.
- One-click MCP install and cleaner docs, with docs now authored in Markdown and served as raw `.md` too.

**Changed**
- Homepage reframed around the unified changelog API that agents can query consistently.
- Smarter media filtering keeps legitimate release icons and screenshots while dropping tracking pixels, avatars, and junk.

**Fixed**
- Broken changelog images now display correctly — Next.js/Vercel image-optimizer URLs (the `/_next/image` proxy links that 404 for outside fetchers) are unwrapped both at ingest and when rendering existing content.
- Multi-page changelogs with crawl mode now capture per-post pages instead of silently returning just the index.
- Month-only, quarter, and season-headed entries (e.g. "Q3 2025", "Fall 2025") now get an approximate date instead of being left undated.
- Theme now renders consistently between server and client, eliminating a flash on load.

## April 11, 2026

**Added**
- Claude Code plugin for the Releases.sh registry — connects to the remote MCP server with read-only tools, an auto-triggering skill for changelog questions, and a `/releases` command for manual lookups.
- Activity sparklines on the home-page organization table, showing each org's last 30 days of release activity at a glance.
- `--parse-instructions` flag to attach custom extraction guidance to a source.

**Changed**
- Media now serves from a dedicated `media.releases.sh` domain.
- Average releases per week is now calculated over a rolling 90-day window for a truer read on current cadence.

**Fixed**
- `--no-feed-url` now actually disables feed re-discovery, fixing sources whose site-wide RSS returned the wrong content (e.g. blog posts instead of changelog entries).
- Feed sources are auto-detected when a feed URL is present, so they're typed correctly.
- Cleaner media rendering — fixed inline video, duplicate galleries, and orphaned bullets.
- Search bar now auto-focuses on the home and search pages.
- Source timelines now respect empty timeframes instead of stretching to fill the row, plus an Activity/Timeline toggle on source pages.
- Restored dark-mode heatmap colors.

## April 10, 2026

**Added**
- `get_organization` MCP tool — inspect an organization's full state (accounts, tags, sources, products, aliases) in a single call.
- ID-first entity resolution everywhere — sources, orgs, and products now resolve by their stable prefixed IDs (`src_`, `org_`, `prod_`) as well as slugs, so lookups don't break when a slug changes.

**Changed**
- Search now groups results as organizations, products, and releases, folding sources into products — no more duplicate hits for the same thing (e.g. searching "Claude Code" or "Turborepo").
- Faster ingestion for static-site changelogs (Docusaurus, VitePress, WordPress, Ghost, Mintlify, etc.) by skipping headless-browser rendering — same content, 10–30x quicker.
- Redesigned organization tables with a 30-day release count, a sortable "Last Release" column with relative timestamps, and hover cards showing top products and totals.
- `latest` now shows release IDs so results are easy to look up directly.

**Fixed**
- Dates across the web app now render in UTC, so they no longer appear in the future for viewers west of UTC.
- Render-hosted changelogs using standard JSON Feed `summary`/`date_modified` fields are now ingested correctly.
- Inactive sources auto-collapse behind an expandable divider on organization pages, keeping the focus on what's actively shipping.
- The activity heatmap now includes the current week.

## April 9, 2026

**Added**
- A remote MCP server at mcp.releases.sh exposing read-only tools to search releases, get the latest releases, list products and organizations, and run AI-powered change summaries and product comparisons — usable directly from AI assistants.
- A one-line `curl | bash` install option served from releases.sh/install, alongside npm, with a tabbed install UI (npm / Shell / MCP) and click-to-copy on the home page and docs.
- Recognition of Fern-hosted documentation as a changelog source, plus better-preserved formatting (headings, code, lists) when converting feed HTML to markdown.
- A `/v1/evaluate` endpoint that evaluates a URL for changelog ingestion (provider detection, feed discovery, markdown probing) and returns structured results.
- `org edit --slug` to rename an organization's slug.

**Changed**
- Refreshed the home page with copy aimed at LLM and agent use cases and an MCP install tab.
- Switched syntax highlighting to Shiki for more reliable, better-looking code blocks in rendered changelogs.

**Fixed**
- Removed a brief flash of the wrong theme on initial page load.

## April 8, 2026

**Added**
- The CLI is now installable from npm as `@buildinternet/releases`, and the public API is open for reads with no setup — compiled binaries point at api.releases.sh out of the box.
- A GitHub-style release activity heatmap on organization pages, showing daily releases over the past year.
- Media in knowledge pages, plus an auto-enrich pipeline that pulls images and video out of changelog content, with per-source parsing instructions and an `enrich --force` flag.

**Changed**
- Admin commands are now gated behind an API key — public users see a focused set of read commands (search, latest, compare, list, stats, and more), with help text that adapts to what's available.
- Single-page scrapes no longer double-render the page, cutting browser-rendering cost while still extracting media directly from content.

## April 7, 2026

**Added**
- Markdown responses from the API — send `Accept: text/markdown` to endpoints like release detail and search to get agent-ready markdown instead of JSON, with a token-count estimate header.
- AI-generated organization knowledge pages that summarize a project's recent direction and trajectory, updated incrementally as new releases land.
- Domain aliases so alternate domains (for example a company's old and new domains) resolve to the same organization or product in lookups and search.

**Changed**
- The public API now lives under a versioned `/v1` prefix (replacing `/api`).
- The CLI, package, and all user-facing references are renamed from "released" to "releases" to match the releases.sh domain; the data directory is now `~/.releases`.
- Public catalog endpoints are now cached at Cloudflare's edge for faster responses.

## April 3, 2026

**Added**
- Scheduled hourly polling that automatically detects and fetches changed feed and GitHub sources, with per-source frequency control.
- `fetch --changed` to refresh only the sources where polling detected upstream changes.
- Per-source fetch buttons in the web status dashboard to trigger a fetch on demand.

**Changed**
- Smoother search: results now update as you type (debounced) with type-filter buttons for organizations, products, sources, and releases.

**Fixed**
- The search page no longer traps keyboard navigation.

## April 2, 2026

**Added**
- Unified search across organizations, products, sources, and releases in a single query, with a `--type` filter in the CLI and entity cards on the web search page.
- Products — multi-product organizations can now group their sources under named products, surfaced in both the API and the web app.
- Categories and freeform tags on organizations and products, with CLI flags, tag subcommands, a `categories` command, and a `--category` filter on listings.
- Changelog auto-discovery via `.well-known` manifests, `AGENTS.md`, root-level changelog files, and `<link rel="changelog">` relations — letting publishers declare where their changelog lives.
- Org avatars (`--avatar` on org add/edit) and optimized image loading on the web.
- A `poll` command and HEAD-based change detection that cheaply checks feed sources for upstream changes before running the full fetch pipeline.

**Changed**
- Redesigned CLI help with grouped commands, a universal flags section, and per-command `help`.
- Source visibility flags are now `--disable` / `--enable`, and disabled sources drop out of fetch, search, latest, and stats by default.
- "Did you mean?" suggestions and case-insensitive slug lookups when an org or source name doesn't match exactly.
- Syntax-highlighted code blocks and JetBrains Mono for code in rendered changelog markdown.
- Hardened handling of externally-sourced changelog content across the CLI, API, and web (safe link/image schemes, security headers, and terminal-injection protection).

## April 1, 2026

**Added**
- Release detail pages — every release now has its own direct-linkable page with full content, media, source attribution, and breadcrumbs, plus permalink icons on list items.
- A combined release feed for each organization that interleaves every source chronologically, with paging for deep history.
- Light/dark mode with a system-default toggle across the web app.
- An optional overlay that marks major AI model launch dates (Claude and GPT families) on the release timeline.
- `add --name` to pass a source name as a flag and `list --query` for case-insensitive filtering of sources by name, slug, or URL.

**Changed**
- Redesigned the organization timeline with a brushable detail chart, a stacked by-source view with an interactive legend, hover-card breakdowns, and quick range presets.
- The home page now lists organizations in a sortable, fully clickable table with a "Last 30 days" activity column.
- Faster page loads from removing redundant database round-trips and adding edge caching on catalog data.

## March 31, 2026

**Added**
- Rich media in release content — images and other assets are now preserved and rendered, served through Cloudflare image transforms, with a backfill command to fill in existing releases.
- A release timeline visualization on each organization page.
- `enrich` command that uses AI triage to flesh out thin release entries on demand.
- An organization description field, surfaced on org pages.

**Changed**
- The release list UI is cleaner and easier to scan.

**Fixed**
- Junk and tracking media are now filtered out of release content.
- Summaries read more naturally — past tense, less verbose, lower reading level, and no editorializing.

## March 30, 2026

**Added**
- AI-generated plain-English summaries for each release.
- `evaluate` command that assesses a URL and recommends the best way to ingest its changelog, now wired into `add`.
- Feed enrichment — sparse feed entries are filled out by fetching the full content of each release page.
- Agent-friendly `.json` and `.md` format routes on the web frontend, so pages can be pulled as raw data or markdown.
- A primary-changelog flag to mark an org's main changelog source.
- `--no-summarize` flag on `fetch` to skip AI summaries when you don't want them.

**Changed**
- All CLI commands now work in remote mode against the hosted API, not just locally.
- Faster ingestion via parallel and incremental changelog parsing, with live progress.
- Fetches now default to a sensible per-run release cap to avoid pagination errors.

**Fixed**
- Cleaner release markdown rendering and more accurate "new since" tracking dates.

## March 27, 2026

**Added**
- `import` command for bringing in existing sources in bulk.
- Org-scoped ignored URLs, a global blocklist, and release suppression — finer control over exactly what gets indexed.
- Remote onboarding mode, so source discovery can run against the hosted backend instead of only locally.

**Changed**
- Smart fetching with backoff that skips sources unlikely to have changed, so re-fetches are faster and cheaper.
- Richer web pages — markdown-rendered release content, source metadata in the sidebar, and clearer source display.
- More agent-friendly CLI: help text now carries real examples, and errors are actionable with clear next steps.
- A helpful setup message now appears across the site when the API isn't reachable yet.

## March 26, 2026

**Added**
- Organizations — group an org's sources together, filter any command or MCP tool by org, and browse releases per company. GitHub sources auto-associate with their org.
- The releases.sh web frontend — a homepage with an organization grid, per-org and per-source pages, and a search results page, with links back to each release's origin.
- Automatic RSS, Atom, and JSON feed discovery, so adding a source can find its feed for you.
- `discover` and `onboard` commands that use AI to find a project's changelog and set it up for you, plus a discover-changelog slash command for agent-driven setup.
- Crawl mode for multi-page changelogs, with automatic detection of blog-index changelog patterns.
- New `edit`, `ignore`, and `stats` commands, batch `add`/`remove`, and `--feed-url`, `--force`, and `--instructions` flags.

**Changed**
- Source type is now auto-detected from the URL when you don't specify one.
- Sharper, higher-quality AI release summaries.

## March 25, 2026

**Added**
- Initial release. Releases is a changelog indexer and registry for developers and AI agents.
- The `releases` command-line tool — add changelog sources, fetch their releases, and query everything from your terminal.
- GitHub and web-scrape source support, so you can index both tagged GitHub releases and hosted changelog pages.
- AI-assisted ingestion that reads a changelog and turns it into clean, structured release entries.
- Full-text search across every release you've indexed.
- A remote MCP server with five tools, so AI agents can search and pull changelog data directly.
- `--json` output on commands for easy scripting and machine consumption.
