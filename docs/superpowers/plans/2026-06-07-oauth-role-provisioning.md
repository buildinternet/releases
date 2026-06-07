# OAuth Role Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `OAUTH_ADMIN_USER_IDS` env bootstrap with a root-key-gated admin route + CLI verb that write the durable `user.role` column (the OAuth scope source of truth), with an audit trail and no redeploy.

**Architecture:** A new admin REST namespace `admin/users` (root-key gated, like every other `/v1/admin/*` route) exposes `PATCH /v1/admin/users/role` plus read endpoints. It validates the role against `ROLE_LADDER` (fail-closed), writes `user.role` via Drizzle, and emits a `logEvent` audit line. The `OAUTH_ADMIN_USER_IDS` var, its helper, and the `adminUserIds` plugin wiring are removed (they are unset in every deployed env → runtime no-op). "operator" is treated as a synonym for `admin`, so `entitlement.ts` is untouched. A separate CLI PR adds `releases admin user set-role/get-role/list-roles`.

**Tech Stack:** Cloudflare Worker + Hono, Drizzle ORM over D1, Better Auth admin plugin (`user.role` column), `@releases/lib/log-event`, bun:test with `tests/db-helper` (in-memory SQLite + migrations).

**Spec:** `docs/superpowers/specs/2026-06-07-oauth-role-provisioning-design.md`

---

## File Structure

**Phase A — monorepo (`workers/api`):**

- Create: `workers/api/src/routes/admin-users.ts` — the three role handlers.
- Create: `workers/api/test/admin-users.test.ts` — route unit tests.
- Modify: `workers/api/src/route-namespaces.ts` — add `"admin/users"` to `adminRoutes`.
- Modify: `workers/api/src/v1-routes.ts` — import + mount `adminUsersRoutes`.
- Modify: `workers/api/src/auth/index.ts` — delete `oauthAdminUserIds` helper + `adminUserIds:` line.
- Modify: `workers/api/src/index.ts` — drop the `OAUTH_ADMIN_USER_IDS?: string` binding.
- Modify: `workers/api/test/oauth-entitlement.test.ts` — remove the `oauthAdminUserIds` block + import.
- Modify: `docs/architecture/remote-mode.md`, `AGENTS.md` — docs.

**Phase B — CLI (`~/Code/releases-cli`, separate PR):**

- Create: `src/cli/commands/admin/user.ts` (or matching the existing admin verb layout) — `set-role`/`get-role`/`list-roles`.
- Modify: the CLI command registry / `src/index.ts` alias map.

**Phase C — prod seed:** one-time D1 write, no files.

---

## Phase A — Monorepo

### Task 1: Role-provisioning route module

**Files:**

- Create: `workers/api/src/routes/admin-users.ts`
- Test: `workers/api/test/admin-users.test.ts`

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/admin-users.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { user } from "../src/db/schema-auth.js";

function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

async function makeApp(db: ReturnType<typeof mkDb>) {
  const { Hono } = await import("hono");
  const { adminUsersRoutes } = await import("../src/routes/admin-users.js");
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", adminUsersRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, { DB: db });
}

async function seed(db: ReturnType<typeof mkDb>) {
  await db.insert(user).values([
    { id: "u_admin", name: "Ada", email: "ada@example.com", role: "admin" },
    { id: "u_cur", name: "Cory", email: "cory@example.com", role: "curator" },
    { id: "u_plain", name: "Pat", email: "pat@example.com" }, // role NULL
  ]);
}

describe("PATCH /v1/admin/users/role", () => {
  it("sets a role by email and returns previous + new", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(
      new Request("http://x/v1/admin/users/role", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "pat@example.com", role: "curator" }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      userId: string;
      role: string;
      previousRole: string | null;
    };
    expect(json).toMatchObject({ userId: "u_plain", role: "curator", previousRole: null });
    const [row] = await db.select({ role: user.role }).from(user).where(eqId(db, "u_plain"));
    expect(row.role).toBe("curator");
  });

  it("revokes by setting role back to user", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(
      new Request("http://x/v1/admin/users/role", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "u_admin", role: "user" }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { previousRole: string | null; role: string };
    expect(json).toMatchObject({ previousRole: "admin", role: "user" });
  });

  it("rejects an unknown role with 400", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(
      new Request("http://x/v1/admin/users/role", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "pat@example.com", role: "superadmin" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects neither/both identifiers with 400", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const neither = await fetch(
      new Request("http://x/v1/admin/users/role", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "curator" }),
      }),
    );
    expect(neither.status).toBe(400);
    const both = await fetch(
      new Request("http://x/v1/admin/users/role", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "pat@example.com", userId: "u_plain", role: "curator" }),
      }),
    );
    expect(both.status).toBe(400);
  });

  it("returns 404 for a missing user", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(
      new Request("http://x/v1/admin/users/role", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.com", role: "curator" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("emits a role-changed audit line", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(String(a[0]));
    try {
      await fetch(
        new Request("http://x/v1/admin/users/role", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "pat@example.com", role: "admin" }),
        }),
      );
    } finally {
      console.log = orig;
    }
    const audit = lines.map((l) => JSON.parse(l)).find((p) => p.event === "role-changed");
    expect(audit).toMatchObject({
      component: "auth",
      targetUserId: "u_plain",
      fromRole: null,
      toRole: "admin",
      actor: "root-key",
    });
  });
});

describe("GET /v1/admin/users/role", () => {
  it("reads a user's current role by email", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(new Request("http://x/v1/admin/users/role?email=cory@example.com"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: "u_cur", role: "curator" });
  });

  it("404s an unknown user", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(new Request("http://x/v1/admin/users/role?email=ghost@example.com"));
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/admin/users/roles", () => {
  it("lists only curator/admin users", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(new Request("http://x/v1/admin/users/roles"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { users: { userId: string; role: string }[] };
    expect(json.users.map((u) => u.userId).sort()).toEqual(["u_admin", "u_cur"]);
  });
});

// Local helper to keep the assertion query terse.
import { eq } from "drizzle-orm";
function eqId(_db: unknown, id: string) {
  return eq(user.id, id);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd workers/api && bun test test/admin-users.test.ts`
Expected: FAIL — `Cannot find module '../src/routes/admin-users.js'`.

- [ ] **Step 3: Create the route module**

Create `workers/api/src/routes/admin-users.ts`:

```ts
/**
 * Admin-only user-role provisioning. Writes the Better Auth `user.role` column —
 * the durable source of truth the OAuth scope entitlement reads
 * (auth/entitlement.ts). Gated by `authMiddleware` (static root key) via the
 * `admin/users` entry in route-namespaces.ts. Replaces the brittle
 * `OAUTH_ADMIN_USER_IDS` env bootstrap (#1484).
 *
 * The settable role set is derived from `ROLE_LADDER` so this route can never
 * drift from the entitlement boundary. Fail-closed: unknown role → 400, missing
 * user → 404, never defaults to admin. "Revoke" = set role back to `user`.
 */
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { logEvent } from "@releases/lib/log-event";
import { ROLE_LADDER } from "../auth/entitlement.js";
import { user } from "../db/schema-auth.js";
import { createDb } from "../db.js";
import type { Env } from "../index.js";

export const adminUsersRoutes = new Hono<Env>();

// oxlint-disable-next-line no-explicit-any
function getDb(c: any): ReturnType<typeof createDb> {
  return c.get("db") ?? createDb(c.env.DB);
}

/** Settable roles, taken from the entitlement ladder (user | curator | admin). */
const VALID_ROLES = new Set(Object.keys(ROLE_LADDER));

/** Exactly one of email/userId → a Drizzle predicate, or null if the pair is invalid. */
function identifierWhere(email: string | undefined, userId: string | undefined) {
  if ((!email && !userId) || (email && userId)) return null;
  return userId ? eq(user.id, userId) : eq(user.email, email as string);
}

adminUsersRoutes.get("/admin/users/role", async (c) => {
  const db = getDb(c);
  const where = identifierWhere(c.req.query("email"), c.req.query("userId"));
  if (!where) return c.json({ error: "exactly one of email or userId required" }, 400);
  const [row] = await db
    .select({ id: user.id, email: user.email, role: user.role })
    .from(user)
    .where(where);
  if (!row) return c.json({ error: "user_not_found" }, 404);
  return c.json({ userId: row.id, email: row.email, role: row.role });
});

adminUsersRoutes.get("/admin/users/roles", async (c) => {
  const db = getDb(c);
  const rows = await db
    .select({ id: user.id, email: user.email, role: user.role })
    .from(user)
    .where(inArray(user.role, ["curator", "admin"]));
  return c.json({ users: rows.map((r) => ({ userId: r.id, email: r.email, role: r.role })) });
});

adminUsersRoutes.patch("/admin/users/role", async (c) => {
  const db = getDb(c);
  let body: { email?: unknown; userId?: unknown; role?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const email = typeof body.email === "string" ? body.email : undefined;
  const userId = typeof body.userId === "string" ? body.userId : undefined;
  const role = typeof body.role === "string" ? body.role : undefined;

  const where = identifierWhere(email, userId);
  if (!where) return c.json({ error: "exactly one of email or userId required" }, 400);
  if (!role || !VALID_ROLES.has(role)) {
    return c.json({ error: "invalid_role", allowed: [...VALID_ROLES] }, 400);
  }

  const [existing] = await db
    .select({ id: user.id, email: user.email, role: user.role })
    .from(user)
    .where(where);
  if (!existing) return c.json({ error: "user_not_found" }, 404);

  await db.update(user).set({ role, updatedAt: new Date() }).where(eq(user.id, existing.id));

  logEvent("info", {
    component: "auth",
    event: "role-changed",
    targetUserId: existing.id,
    targetEmail: existing.email,
    fromRole: existing.role ?? null,
    toRole: role,
    actor: "root-key",
  });

  return c.json({
    userId: existing.id,
    email: existing.email,
    previousRole: existing.role ?? null,
    role,
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd workers/api && bun test test/admin-users.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/routes/admin-users.ts workers/api/test/admin-users.test.ts
git commit -m "feat(api): admin/users role-provisioning route (#1484)"
```

---

### Task 2: Register and mount the namespace

**Files:**

- Modify: `workers/api/src/route-namespaces.ts` (the `adminRoutes` array)
- Modify: `workers/api/src/v1-routes.ts` (import + mount)

- [ ] **Step 1: Add the namespace to `adminRoutes`**

In `workers/api/src/route-namespaces.ts`, add `"admin/users"` to the `adminRoutes` array (next to the other `admin/*` entries):

```ts
  "admin/batch-runs",
  "admin/users",
```

This makes `/admin/users` + `/admin/users/*` inherit the root-key `authMiddleware` and admin CORS via the existing loops in `index.ts`.

- [ ] **Step 2: Import + mount in `v1-routes.ts`**

Add the import next to the other admin route imports:

```ts
import { adminUsersRoutes } from "./routes/admin-users.js";
```

And mount it next to the other admin mounts inside `mountV1Routes`:

```ts
v1.route("/", adminBatchRunsRoutes);
v1.route("/", adminUsersRoutes);
```

- [ ] **Step 3: Type-check + lint**

Run: `cd workers/api && npx tsc --noEmit && cd ../.. && bun run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add workers/api/src/route-namespaces.ts workers/api/src/v1-routes.ts
git commit -m "feat(api): register + mount admin/users namespace (#1484)"
```

---

### Task 3: Remove `OAUTH_ADMIN_USER_IDS`

**Files:**

- Modify: `workers/api/test/oauth-entitlement.test.ts` (remove block + import)
- Modify: `workers/api/src/auth/index.ts` (remove helper + `adminUserIds:` line)
- Modify: `workers/api/src/index.ts` (remove binding)

- [ ] **Step 1: Remove the test block first (so the suite tracks the removal)**

In `workers/api/test/oauth-entitlement.test.ts`:

- Change the import on line ~14 from `import { oauthAdminUserIds, createAuth } from "../src/auth/index.js";` to `import { createAuth } from "../src/auth/index.js";`.
- Delete the entire `describe("oauthAdminUserIds", () => { ... });` block (lines ~167–180).

- [ ] **Step 2: Remove the helper + plugin wiring in `auth/index.ts`**

Delete the `oauthAdminUserIds` function (the doc-comment + the export, lines ~249–260):

```ts
// DELETE this whole block:
export function oauthAdminUserIds(env: Bindings): string[] {
  return (env.OAUTH_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}
```

In the `admin({ ... })` registration, remove the `adminUserIds` line so it reads:

```ts
    admin({
      roles: { admin: adminAc, user: userAc, curator: userAc },
      adminRoles: ["admin"],
      defaultRole: "user",
    }),
```

Update the comment above `admin(...)` so it no longer claims `adminUserIds` bootstraps the first admin — replace that sentence with: "First admin is provisioned via `PATCH /v1/admin/users/role` (root-key gated); see docs/architecture/remote-mode.md."

- [ ] **Step 3: Remove the binding in `index.ts`**

Delete the `OAUTH_ADMIN_USER_IDS?: string;` line from the `Bindings` interface (line ~312).

- [ ] **Step 4: Verify nothing else references the symbol**

Run: `grep -rn "OAUTH_ADMIN_USER_IDS\|oauthAdminUserIds" workers/ --include="*.ts"`
Expected: no matches.

- [ ] **Step 5: Run the affected tests + type-check**

Run: `cd workers/api && bun test test/oauth-entitlement.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors. (`entitlement.ts` is unchanged, so the entitlement assertions stay green.)

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/auth/index.ts workers/api/src/index.ts workers/api/test/oauth-entitlement.test.ts
git commit -m "refactor(auth): remove OAUTH_ADMIN_USER_IDS bootstrap (#1484)"
```

---

### Task 4: Docs

**Files:**

- Modify: `docs/architecture/remote-mode.md` (Auth model)
- Modify: `AGENTS.md` (conventions line, if it references the env bootstrap)

- [ ] **Step 1: Document the provisioning route in `remote-mode.md`**

In the Auth model section, add a short subsection describing role provisioning. Use this content:

```markdown
#### Role provisioning (admin/curator)

A user's OAuth scope ceiling comes from the `user.role` column (`user`→read,
`curator`→read+write, `admin`→read+write+admin; NULL/unknown → read-only,
fail-closed — see `workers/api/src/auth/entitlement.ts`). Roles are managed
through a root-key-gated admin route — no redeploy, audited via the
`role-changed` `logEvent` (component `auth`):

- `PATCH /v1/admin/users/role` `{ email | userId, role }` — set a role.
  "Revoke" = set role to `user`.
- `GET /v1/admin/users/role?email=|userId=` — read a user's role.
- `GET /v1/admin/users/roles` — list curator/admin users.

The CLI wraps these as `releases admin user set-role|get-role|list-roles`.

**Bootstrap:** the first admin is seeded once by a direct D1 write
(`UPDATE user SET role='admin' WHERE email=…`); thereafter that admin grants
others via the route (or Better Auth's native `setRole` in the browser, which a
role=admin user is authorized for). The former `OAUTH_ADMIN_USER_IDS` env
bootstrap has been removed.
```

- [ ] **Step 2: Update the `AGENTS.md` conventions line**

In `AGENTS.md`, find the scoped-API-tokens / auth conventions bullet that mentions the role column and add a clause pointing at the route, e.g. append: "Roles (the OAuth scope source of truth) are provisioned via the root-key-gated `PATCH /v1/admin/users/role` route / `releases admin user set-role` — not an env var."

If no existing bullet fits cleanly, leave `AGENTS.md` unchanged (the `remote-mode.md` detail is authoritative) — do not invent a new top-level section.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/remote-mode.md AGENTS.md
git commit -m "docs(auth): document role provisioning route, drop OAUTH_ADMIN_USER_IDS (#1484)"
```

---

### Task 5: Full gate

- [ ] **Step 1: Run the worker test suite**

Run: `cd workers/api && bun test`
Expected: PASS (admin-users + oauth-entitlement + everything else).

- [ ] **Step 2: Type-check root + worker**

Run: `npx tsc --noEmit && cd workers/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint + format check**

Run: `bun run lint && bun run format:check`
Expected: clean. (If `format:check` flags the new files, run `bun run format` and amend.)

- [ ] **Step 4: Open the monorepo PR**

```bash
git push -u origin worktree-oauth-role-provisioning-1484
gh pr create --title "feat(oauth): role provisioning route, replace OAUTH_ADMIN_USER_IDS (#1484)" --body-file <(cat <<'EOF'
Replaces the `OAUTH_ADMIN_USER_IDS` env bootstrap with a root-key-gated
`PATCH /v1/admin/users/role` route (+ read endpoints) that write the durable
`user.role` column — the OAuth scope source of truth — with a `role-changed`
audit line and no redeploy. "operator" = synonym for `admin`, so
`entitlement.ts` is untouched. The env var (unset in every deployed env) and its
helper/wiring are removed.

Closes #1484. Unblocks #1482, #1483. CLI verbs ship separately in releases-cli.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)
```

---

## Phase B — CLI verbs (`~/Code/releases-cli`, separate PR)

> Execute against the CLI repo. First read an existing admin verb (e.g. `src/cli/commands/admin/org.*` and the alias map in `src/index.ts`) to match the exact client construction, arg parser, and output style. Use the existing API client (which already sends the root key) — do NOT hand-roll fetch/auth.

### Task 6: `releases admin user set-role / get-role / list-roles`

**Files:**

- Create: `src/cli/commands/admin/user.ts` (match the actual admin-command file layout you find)
- Modify: the CLI command registry / `src/index.ts` alias map to register the `admin user` verbs

- [ ] **Step 1: Read the existing admin-verb pattern**

Run: `sed -n '1,80p' src/cli/commands/admin/org.ts` (or the closest existing admin command). Note how it gets the API base + key, parses flags, and prints results.

- [ ] **Step 2: Implement `set-role`**

Add a handler that:

- parses `--email <e>` / `--user-id <id>` (exactly one) and `--role <user|curator|admin>`,
- calls `PATCH /v1/admin/users/role` with `{ email | userId, role }`,
- on 200 prints `email: <previousRole> → <role>`,
- maps 400/404 to a clear non-zero-exit error message.

- [ ] **Step 3: Implement `get-role` + `list-roles`**

- `get-role --email|--user-id` → `GET /v1/admin/users/role?…`, prints `email: role`.
- `list-roles` → `GET /v1/admin/users/roles`, prints a table of `email role`.

- [ ] **Step 4: Register the verbs**

Wire `admin user set-role|get-role|list-roles` into the command registry the same way the other `admin` subcommands are registered.

- [ ] **Step 5: Tests + smoke**

Add a unit test mirroring the repo's existing CLI command tests (mock the client; assert the request path/body and the rendered output). Watch the `getApiUrl()` memoization gotcha — use `https://test.example.com` or match by path suffix so the suite-wide cache doesn't poison the assertion.

Run: `bun test` (CLI repo). Expected: PASS.

- [ ] **Step 6: Commit + PR**

```bash
git checkout -b feat/admin-user-set-role
git add -A && git commit -m "feat(admin): user set-role/get-role/list-roles verbs (releases#1484)"
git push -u origin feat/admin-user-set-role
gh pr create --title "feat(admin): user role provisioning verbs" --body "Wraps PATCH/GET /v1/admin/users/role from buildinternet/releases#1484."
```

---

## Phase C — Bootstrap the first admin (after Phase A merges + deploys)

### Task 7: Seed `dunn.zach@gmail.com` → admin

- [ ] **Step 1: Confirm the deploy landed**

The monorepo PR merge auto-deploys the API worker. Confirm `PATCH /v1/admin/users/role` exists (e.g. a root-key `GET /v1/admin/users/roles` returns 200) before seeding — or seed via direct D1 (below), which is independent of the deploy.

- [ ] **Step 2: Write the role via direct prod D1**

```bash
set -a; . ./.env; set +a   # loads CLOUDFLARE_ACCOUNT_ID (Build Internet); required for non-interactive prod D1
bunx wrangler d1 execute released-db --remote --config workers/api/wrangler.jsonc \
  --command "UPDATE user SET role='admin' WHERE email='dunn.zach@gmail.com';"
```

- [ ] **Step 3: Verify**

```bash
bunx wrangler d1 execute released-db --remote --config workers/api/wrangler.jsonc \
  --command "SELECT id, email, role FROM user WHERE email='dunn.zach@gmail.com';"
```

Expected: one row, `role = admin`. (Reversible: re-run with `role='user'`.)

---

## Self-Review

**Spec coverage:**

- Route `PATCH/GET /v1/admin/users/role` + `GET /roles` → Task 1. ✓
- Fail-closed validation (ROLE_LADDER, 400/404) → Task 1 tests + impl. ✓
- Audit `logEvent` → Task 1 (`role-changed` + console-spy test). ✓
- Root-key gating via `adminRoutes` + mount → Task 2. ✓
- Remove env var/helper/binding/test → Task 3. ✓
- `entitlement.ts` untouched (operator=admin) → no task modifies it (by design). ✓
- Docs (remote-mode.md, AGENTS.md) → Task 4. ✓
- Full gate (test/tsc/lint/format) + PR → Task 5. ✓
- CLI verbs → Phase B / Task 6. ✓
- First-admin seed → Phase C / Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step has full code; the only "read the existing pattern" steps are in Phase B against a separate repo not in this worktree, with concrete follow-on steps. ✓

**Type consistency:** Route exports `adminUsersRoutes`; test imports it from `../src/routes/admin-users.js`; `VALID_ROLES`/`identifierWhere` are defined and used within the same module; response shape `{ userId, email, previousRole, role }` matches the test assertions. ✓
