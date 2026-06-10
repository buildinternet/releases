[Nimbus](/) · [Updates](/updates) · [API](/api) · [Login](/login)

# Realtime presence for collaborative documents

_March 3, 2026_

Documents now show who else is viewing or editing in realtime. Avatars appear in the top-right of every doc, cursors are colored per-collaborator, and selections are shared live over our existing WebSocket channel.

Presence is on by default for all workspaces. You can disable it per-document from **Share → Privacy → Hide collaborators**, and enterprise admins can disable it workspace-wide via the admin console.

There is no performance cost for solo editing — presence frames are only sent when a second collaborator joins the document.

## More updates

- [Faster cold starts for edge functions](/updates/edge-cold-starts) — February 24, 2026
- [Two-factor authentication via passkeys](/updates/passkeys) — February 10, 2026
- [Redesigned billing dashboard](/updates/billing-redesign) — January 28, 2026

[See all updates →](/updates)

Made in San Francisco. [Careers](/careers) · [Brand](/brand)
