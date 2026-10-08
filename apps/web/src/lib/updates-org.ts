/**
 * The registry org that `/updates` ("What's New") is the branded face of —
 * Release Notes Index publishes its own changelog through its own registry.
 * Shared by the `/updates` pages, the sitemap, and `POST /api/revalidate`
 * (which also refreshes `/updates` when this org ingests). Keep in sync with
 * the seeded org (docs/superpowers/specs/2026-06-10-self-published-changelog-design.md).
 */
export const UPDATES_ORG_SLUG = "releases-sh";
