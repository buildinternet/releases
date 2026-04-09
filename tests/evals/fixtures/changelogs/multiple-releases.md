# Changelog

## v2.3.0 — February 28, 2024

### Features
- Added webhook support for external integrations
- New CSV export for analytics dashboard

### Improvements
- Reduced API response time by 40%
- Updated dependency versions

## v2.2.1 — February 10, 2024

### Bug Fixes
- Fixed authentication token refresh failing silently
- Corrected timezone handling in scheduled reports

## v2.2.0 — January 25, 2024

### Features
- **Real-time collaboration** on shared documents
- Added support for custom domains

### Breaking Changes
- The `/api/v1/users` endpoint now requires pagination parameters. Requests without `limit` and `offset` will return a 400 error.
- Removed deprecated `GET /api/v1/legacy-export` endpoint.

## v2.1.0 — January 5, 2024

### Features
- Initial release of the analytics dashboard
- Added email notification preferences
