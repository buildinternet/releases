# Released Web Frontend

Public, read-only catalog for browsing organizations, sources, and releases tracked by the Released CLI.

## Goals

- Public directory of tracked changelogs, browsable by anyone
- Surface release velocity metrics (avg/week, last 30 days) to show rate of progress
- Architecture that leaves a clear path toward authenticated personal/team views later
- Simple, minimal aesthetic inspired by Context7, skills.sh, companies.sh

## Non-Goals (v1)

- Authentication or user accounts
- Write operations (adding sources, orgs)
- Real-time updates or WebSocket connections
- Individual release detail pages

## Architecture

Two components:

1. **API server** — new `api` command in the CLI, starts a Bun HTTP server exposing read-only JSON endpoints against the existing SQLite database. Default port 3456, configurable via `--port` flag or `RELEASED_API_PORT` env var. Uses the same database path resolution as existing CLI commands.
2. **Next.js frontend** — `web/` directory within the existing repo, fetches from the API, deployed independently

The API lives in the CLI for now. It can be extracted to its own service later without changing the frontend.

## Pages

### Homepage (`/`)

- Global search bar (full-text search across all releases)
- Top-level stats: org count, source count, release count
- **Organizations** section: two-column grid of org cards
  - Each card: org name, domain, source count
- **Independent Projects** section: sources without an org
  - Each card: source name, source URL hostname, subtle source-type icon (no description field — sources don't have one)

### Org Page (`/:orgSlug`)

Two-column layout: content left, metadata sidebar right.

**Left column:**
- Breadcrumb: Home / Org Name
- Org name as page title
- Source cards (single column, stacked):
  - Source name + subtle source-type icon (e.g. GitHub mark at low opacity)
  - Source URL hostname as subtitle (sources don't have a description field)
  - Latest version, date, total release count

**Right sidebar:**
- Domain
- Source count
- Total releases (large number)
- Last 30 days (release count)
- Avg per week (release rate)
- Linked accounts (icon + handle, e.g. GitHub icon + "vercel")
- Tracking since (date)

### Source Page (`/:orgSlug/:sourceSlug` or `/source/:slug` for independents)

Two-column layout: content left, metadata sidebar right.

**Left column:**
- Breadcrumb: Org Name / Source Name (or Home / Source Name for independents)
- Source name as page title + subtle source-type icon
- Release list (paginated):
  - Version (bold) + date (right-aligned)
  - Title (one line)
  - Summary (1-2 lines, muted)
- Pagination controls at bottom

**Right sidebar:**
- Total releases (large number)
- Last 30 days (release count)
- Avg per week (release rate)
- Latest version + date
- Organization (linked, if applicable)
- Source URL
- Tracking since (date)

## URL Structure

| Page | URL |
|------|-----|
| Homepage | `/` |
| Org | `/:orgSlug` |
| Source (org-affiliated) | `/:orgSlug/:sourceSlug` |
| Source (independent) | `/source/:slug` |
| Search results | `/search?q=` |

## API Endpoints

New `api` command in the CLI starts a Bun HTTP server. All endpoints are read-only (`GET`), return JSON, support CORS.

### `GET /api/stats`
Top-level counts for the homepage.
```json
{
  "orgs": 142,
  "sources": 384,
  "releases": 12847
}
```

### `GET /api/orgs`
List all organizations with source counts.
```json
[{
  "slug": "vercel",
  "name": "Vercel",
  "domain": "vercel.com",
  "sourceCount": 8,
  "releaseCount": 412,
  "lastActivity": "2026-03-24T00:00:00Z"
}]
```

### `GET /api/orgs/:slug`
Org detail with sources list and activity metrics.
```json
{
  "slug": "vercel",
  "name": "Vercel",
  "domain": "vercel.com",
  "sourceCount": 8,
  "releaseCount": 412,
  "releasesLast30Days": 18,
  "avgReleasesPerWeek": 4.2,
  "trackingSince": "2026-01-12T00:00:00Z",
  "accounts": [
    { "platform": "github", "handle": "vercel" },
    { "platform": "github", "handle": "vercel-labs" }
  ],
  "sources": [{
    "slug": "next-js",
    "name": "Next.js",
    "type": "github",
    "releaseCount": 247,
    "latestVersion": "v15.3.1",
    "latestDate": "2026-03-24T00:00:00Z"
  }]
}
```

### `GET /api/sources/:slug`
Source detail with paginated releases.
```json
{
  "slug": "next-js",
  "name": "Next.js",
  "type": "github",
  "url": "https://github.com/vercel/next.js",
  "org": { "slug": "vercel", "name": "Vercel" },
  "releaseCount": 247,
  "releasesLast30Days": 6,
  "avgReleasesPerWeek": 1.4,
  "latestVersion": "v15.3.1",
  "latestDate": "2026-03-24T00:00:00Z",
  "trackingSince": "2026-01-12T00:00:00Z",
  "releases": [{
    "version": "v15.3.1",
    "title": "Improved Turbopack stability",
    "summary": "Bug fixes for Turbopack HMR, improved CSS module resolution...",
    "publishedAt": "2026-03-24T00:00:00Z",
    "url": "https://github.com/vercel/next.js/releases/tag/v15.3.1"
  }],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalPages": 13,
    "totalItems": 247
  }
}
```
Query params: `?page=1&pageSize=20`

### `GET /api/sources`
List all sources. Used for the "Independent Projects" homepage section.
Query param: `?independent=true` returns only sources where `orgId` is null.
Without the param, returns all sources.
```json
[{
  "slug": "htmx",
  "name": "htmx",
  "type": "github",
  "url": "https://github.com/bigskysoftware/htmx",
  "orgSlug": null,
  "releaseCount": 42,
  "latestVersion": "v2.0.4",
  "latestDate": "2026-03-20T00:00:00Z"
}]
```

### `GET /api/search?q=`
Full-text search across releases.
```json
{
  "query": "turbopack",
  "results": [{
    "sourceSlug": "next-js",
    "sourceName": "Next.js",
    "orgSlug": "vercel",
    "version": "v15.3.1",
    "title": "Improved Turbopack stability",
    "summary": "Bug fixes for Turbopack HMR...",
    "publishedAt": "2026-03-24T00:00:00Z"
  }]
}
```
Query params: `?q=&limit=20&offset=0`. The `total` field is omitted — the client detects end-of-results when fewer than `limit` results are returned. This avoids a separate FTS5 count query.

## URL-to-API Resolution

The frontend URL `/:orgSlug/:sourceSlug` maps to two API calls: `GET /api/orgs/:orgSlug` (to verify the org exists and get context), then `GET /api/sources/:sourceSlug` (source slugs are globally unique). The `sourceSlug` in the URL is the same as `sources.slug` in the database. The org slug prefix is for display/hierarchy only — the source is always looked up by its own slug.

If the source's `orgSlug` doesn't match the URL's org segment, redirect to the correct canonical URL. Likewise, if a source is accessed at `/source/:slug` but actually belongs to an org, redirect to `/:orgSlug/:sourceSlug`.

## API Error Responses

All error responses use a consistent shape:
```json
{
  "error": "not_found",
  "message": "No source with slug 'foo'"
}
```

| Status | When |
|--------|------|
| 400 | Missing required query param (e.g. `q` on search), invalid `page`/`pageSize` |
| 404 | Unknown org or source slug |
| 500 | Unexpected server error |

Search with empty or missing `q` returns 400.

## Activity Metrics Computation

Both "releases in last 30 days" and "avg releases per week" are computed server-side by the API from the `releases.publishedAt` column:

- **Last 30 days:** `COUNT(*) WHERE publishedAt >= now - 30 days`
- **Avg per week:** `total releases / weeks since first release` (using `publishedAt` of the oldest release and the current date). If the span is less than 1 week (new source or single release), display the total count as the weekly rate.

These apply at both the source level and the org level. Org-level metrics are computed from the org's combined release history (not summing per-source averages).

## Visual Design

- **Color palette:** Stone/warm neutrals (stone-50 background, stone-900 text, stone-400 muted)
- **Typography:** System font stack, tight letter-spacing on headings
- **Source type indicators:** Platform icons (GitHub mark, RSS icon, globe for scrape) rendered at low opacity (~25%) — subtle, not prominent
- **Layout:** Max-width container, two-column on detail pages (content + sidebar), two-column grid on homepage
- **Cards:** White background, 1px stone-200 border, 8px radius
- **Sidebar metadata:** Small uppercase labels (11px, stone-400), prominent values below. Large numbers (22px, bold) for counts/rates. Sections separated by thin borders.

## Frontend Tech

- Next.js 15 with App Router
- Server Components for data fetching (no client-side state needed for v1)
- Tailwind CSS for styling
- No auth libraries, no client state management
- API URL configured via environment variable (`RELEASED_API_URL`) — points at the host/port where the CLI `api` command is running

## Field Notes

- **`trackingSince`**: Uses `sources.createdAt` (when the source was added to Released). This reflects when we started tracking, not the date of the oldest release.
- **Source descriptions**: Sources don't have a description field. Source cards use the URL hostname as a subtitle instead.
- **Null `publishedAt`**: Releases with null `publishedAt` sort to the end of the list (after all dated releases). The `latestVersion`/`latestDate` fields in API responses use the most recent non-null `publishedAt`. If all releases have null dates, `latestDate` is null and `latestVersion` uses the most recently fetched release.

## Release Summary Field

The release summary shown in the list view uses the existing `contentSummary` field from the database (AI-generated). If `contentSummary` is null, the API truncates `content` to ~150 characters as a fallback.
