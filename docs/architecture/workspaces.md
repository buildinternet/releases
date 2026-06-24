# Workspaces (Better Auth organization module)

**Workspaces** are user-tenancy units backed by Better Auth's built-in `organization`
plugin — the foundation for future team-centric features. Every user transparently gets a
personal workspace; they can create more.

> **Workspaces are NOT the registry `organizations`.** The registry `organizations` table
> (plural, `@buildinternet/releases-core`) is the indexed _vendors_ whose changelogs we
> track (Vercel, Stripe, …). A workspace is a tenancy unit for human _users_. The two are
> deliberately separate — there is no link between them today. The SQL table names differ
> (`organization` singular vs `organizations` plural), so D1 sees two distinct tables.

## What ships

- The `organization()` plugin (core `better-auth`, no extra package) is registered
  **always-on, no feature flag** in `workers/api/src/auth/index.ts`. It's additive and inert
  for anyone who never creates a second workspace.
- Built-in `owner` / `admin` / `member` roles; **no teams**, no custom access-control roles.
- Tables (`auth*`-prefixed Drizzle vars, BA-default SQL names) live in the worker-local
  `workers/api/src/db/schema-auth.ts`: `authOrganization` → `organization`, `authMember` →
  `member`, `authInvitation` → `invitation`, plus the `@better-auth/stripe` `subscription`
  table. New columns: `session.active_organization_id`, `user.last_active_organization_id`.
- Account UI: `/account/workspaces` (list / create / switch active); each row links to
  `/account/workspaces/[id]` to manage that workspace's **members** (roster, role
  toggle member⇄admin, remove, leave) and **invitations** (invite by email, cancel,
  resend). The `/accept-invitation/[id]` page handles the emailed invite link
  (sign-in prompt, email-mismatch, invalid, and accept/decline).

## Personal-workspace provisioning (lazy)

Provisioning is **lazy**, in a `databaseHooks.session.create.before` hook
(`ensureActiveWorkspace`, `auth/workspace.ts`) — so it backfills existing users on their
next sign-in with no migration script, and never blocks sign-in (all errors are swallowed).

```mermaid
flowchart TD
    SignIn[Session created on sign-in] --> Hook["session.create.before"]
    Hook --> Ensure["ensureActiveWorkspace(db, userId)"]
    Ensure -->|0 memberships| Create["Create org + owner member (atomic db.batch)<br/>slug = ws-&lt;userId&gt; (deterministic)"]
    Ensure -->|1 membership| One[Return it]
    Ensure -->|&gt;1| Many["Prefer user.last_active_organization_id<br/>else oldest membership"]
    Create -->|UNIQUE(slug) race| Adopt["Adopt the winner's org<br/>(same user → same slug)"]
    Create --> Seed
    One --> Seed
    Many --> Seed
    Adopt --> Seed
    Seed["session.activeOrganizationId = orgId"]
```

The slug is namespaced by user id (`ws-<userId>`) so two concurrent first-logins for the
same user collide on `UNIQUE(slug)`; the atomic `db.batch` makes the loser adopt the
winner's org+member rather than create a duplicate. `session.update.after` mirrors the
active workspace into `user.last_active_organization_id` so the selection is sticky across
sessions for multi-workspace users.

## Roles: `member.role` ≠ `user.role`

The org `member.role` (`owner`/`admin`/`member`) governs what a user can do **within a
workspace**. It is entirely separate from `user.role` (the Better Auth `admin` plugin
column), which drives the **OAuth scope ceiling** in `auth/entitlement.ts`
(user→read, curator→read+write, admin→read+write+admin). Never conflate the two.

## Stripe org-billing seam (inert)

`buildStripePlugin` (`auth/index.ts`) wires the `@better-auth/stripe` subscription feature
but keeps it **inert**: `subscription.enabled` with `plans: []` means the `subscription`
table + endpoints exist yet nothing is purchasable, so no row is ever written (zero user
impact). Subscriptions are keyed to the workspace (`referenceId` = organization id) and
gated by `authorizeReference` → `isOrgOwnerOrAdmin` (owner/admin only). The Stripe Customer
stays **per-user** (`createCustomerOnSignUp`); only the subscription is org-scoped. The
whole block stays inside `buildStripePlugin`, which returns `null` without the Stripe
secrets — so local/staging are fully inert. Adding real plans later activates org billing
with no further plumbing.

## Out of scope (follow-ups)

- A workspace switcher in the global nav (deferred until something in the product reads
  the active workspace).
- A public `/v1/workspaces` REST surface, CLI commands, or MCP tools (the web UI drives
  Better Auth's own `/api/auth/organization/*` endpoints directly).
- Teams sub-feature; custom access-control roles.
- Live Stripe plans / checkout / customer portal; a per-organization Stripe customer model.
- Any relationship between workspaces and the registry `organizations`.
