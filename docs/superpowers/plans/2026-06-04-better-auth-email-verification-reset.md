# Better Auth Email Verification + Password Reset — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate email/password accounts behind a verification link (no session until verified) and add a forgot/reset-password flow, with both emails sent via Cloudflare Email Sending.

**Architecture:** A new never-throwing `sendAuthEmail` helper sends user-facing mail through a dedicated `AUTH_EMAIL` Cloudflare Email Sending binding (object-form `send()`). `createAuth` gains `requireEmailVerification`, `sendOnSignUp`, `autoSignInAfterVerification`, `sendResetPassword`, and `revokeSessionsOnPasswordReset`; its email hooks fire-and-forget via Better Auth's documented Cloudflare `AsyncLocalStorage`/`waitUntil` pattern. The web app gains a "check your email" state, a 403-unverified resend path, and `/forgot-password` + `/reset-password` pages. No DB migration — the existing `verification` table and `user.email_verified` column are reused.

**Tech Stack:** TypeScript (strict), Bun, Hono, Cloudflare Workers + D1, Drizzle, Better Auth, Next.js (App Router), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-04-better-auth-email-verification-reset-design.md`

**Working tree:** worktree `better-auth-email` (branch `worktree-better-auth-email`). Run `bun install` in the worktree first if `node_modules` is missing (it shares nothing with the main checkout).

---

## File structure

**Server (`workers/api/`)**

- `src/auth/email.ts` _(new)_ — `sendAuthEmail` + `verifyEmailTemplate` / `resetPasswordTemplate` + `AuthEmailBinding`/`AuthEmailMessage` types. Single responsibility: turn an auth event into a sent (or logged) email.
- `test/auth-email.test.ts` _(new)_ — unit tests for the helper + templates.
- `src/auth/index.ts` _(modify)_ — verification/reset config, the `AsyncLocalStorage` exec-ctx seam, injectable `CreateAuthDeps`.
- `test/auth.test.ts` _(modify)_ — add an integration block for the verification gate.
- `src/index.ts` _(modify)_ — wrap the `/api/auth/*` handler in `runWithExecCtx`; add `Env` fields.
- `wrangler.jsonc` _(modify)_ — `AUTH_EMAIL` binding + `AUTH_EMAIL_FROM*` vars (prod + staging).

**Web (`web/`)**

- `src/lib/auth-client.ts` _(modify)_ — re-export `requestPasswordReset`, `resetPassword`, `sendVerificationEmail`.
- `src/components/auth-form.tsx` _(modify)_ — check-email state, 403 resend, forgot link.
- `src/components/forgot-password-form.tsx` _(new)_ — client form → `requestPasswordReset`.
- `src/components/reset-password-form.tsx` _(new)_ — client form → `resetPassword`.
- `src/app/forgot-password/page.tsx` _(new)_ — gated server page shell.
- `src/app/reset-password/page.tsx` _(new)_ — gated server page shell; reads `?token`/`?error`.

> **Web testing note:** the web app has no React-component test runner (only pure-logic `*.test.ts`). Web tasks (4–6) are verified by `tsc` + the live smoke in Task 7, not unit tests — matching the spec's test plan. The worker tasks (1–2) are full TDD against `bun:test`.

---

## Task 1: `sendAuthEmail` helper + email templates

**Files:**

- Create: `workers/api/src/auth/email.ts`
- Test: `workers/api/test/auth-email.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `workers/api/test/auth-email.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import {
  sendAuthEmail,
  verifyEmailTemplate,
  resetPasswordTemplate,
  type AuthEmailBinding,
  type AuthEmailMessage,
} from "../src/auth/email.js";

describe("auth email templates", () => {
  it("verifyEmailTemplate embeds the url in text + html and sets a subject", () => {
    const url = "https://api.releases.localhost/api/auth/verify-email?token=abc123";
    const t = verifyEmailTemplate({ url });
    expect(t.subject.length).toBeGreaterThan(0);
    expect(t.text).toContain("token=abc123");
    expect(t.html).toContain("token=abc123");
  });

  it("resetPasswordTemplate embeds the url in text + html and sets a subject", () => {
    const url = "https://api.releases.localhost/api/auth/reset-password/tok?callbackURL=x";
    const t = resetPasswordTemplate({ url });
    expect(t.subject.length).toBeGreaterThan(0);
    expect(t.text).toContain("reset-password/tok");
    expect(t.html).toContain("reset-password/tok");
  });
});

describe("sendAuthEmail", () => {
  const msg: AuthEmailMessage = {
    to: "u@example.com",
    subject: "Subject",
    text: "Click https://x/verify?token=t to continue",
    html: "<p>Click <a href='https://x/verify?token=t'>here</a></p>",
  };

  it("returns no_binding (and does not throw) when AUTH_EMAIL is absent", async () => {
    const res = await sendAuthEmail({}, msg);
    expect(res).toEqual({ sent: false, reason: "no_binding" });
  });

  it("calls the binding with the object-form shape when present", async () => {
    const calls: Array<Parameters<AuthEmailBinding["send"]>[0]> = [];
    const env = {
      AUTH_EMAIL: {
        send: async (m: Parameters<AuthEmailBinding["send"]>[0]) => {
          calls.push(m);
          return { messageId: "mid-1" };
        },
      },
      AUTH_EMAIL_FROM: "noreply@releases.sh",
    };
    const res = await sendAuthEmail(env as never, msg);
    expect(res).toEqual({ sent: true, messageId: "mid-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe("u@example.com");
    expect(calls[0]?.from).toContain("noreply@releases.sh");
    expect(calls[0]?.subject).toBe("Subject");
    expect(calls[0]?.text).toContain("token=t");
    expect(calls[0]?.html).toContain("token=t");
  });

  it("swallows a send failure (returns error, never throws)", async () => {
    const env = {
      AUTH_EMAIL: {
        send: async () => {
          throw new Error("email-sending beta unavailable");
        },
      },
    };
    const res = await sendAuthEmail(env as never, msg);
    expect(res).toEqual({ sent: false, reason: "error" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test workers/api/test/auth-email.test.ts`
Expected: FAIL — `Cannot find module '../src/auth/email.js'`.

- [ ] **Step 3: Implement the helper + templates**

Create `workers/api/src/auth/email.ts`:

```ts
/**
 * User-facing auth email (verification + password reset) over Cloudflare Email
 * Sending — the transactional product that delivers to ARBITRARY recipients (any
 * new-signup address), distinct from the Email Routing `SEND_EMAIL` binding used
 * for internal ops notifications (which only reaches account-verified addresses).
 *
 * `sendAuthEmail` NEVER throws: a missing binding or a send failure degrades to a
 * logged event and a `{ sent: false }` result, so it can't surface as an unhandled
 * rejection inside Better Auth's request flow. It always logs the action — the
 * link is in `text` — so a local `wrangler dev` run (which SIMULATES sends rather
 * than delivering) can complete the verify/reset flow by copy-pasting the URL from
 * Worker logs.
 */
import { logEvent } from "@releases/lib/log-event";

/** The Cloudflare Email Sending binding (object-form `send`). */
export interface AuthEmailBinding {
  send(message: {
    to: string;
    from: string;
    subject: string;
    html?: string;
    text?: string;
  }): Promise<{ messageId?: string }>;
}

export type AuthEmailEnv = {
  AUTH_EMAIL?: AuthEmailBinding;
  AUTH_EMAIL_FROM?: string;
  AUTH_EMAIL_FROM_NAME?: string;
  ENVIRONMENT?: string;
};

/** A fully-rendered email (subject + both bodies); the recipient is `to`. */
export type AuthEmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type SendAuthEmailResult =
  | { sent: true; messageId?: string }
  | { sent: false; reason: "no_binding" | "error" };

const DEFAULT_FROM = "noreply@releases.sh";
const DEFAULT_FROM_NAME = "Releases";

export async function sendAuthEmail(
  env: AuthEmailEnv,
  msg: AuthEmailMessage,
): Promise<SendAuthEmailResult> {
  const addr = env.AUTH_EMAIL_FROM || DEFAULT_FROM;
  const name = env.AUTH_EMAIL_FROM_NAME || DEFAULT_FROM_NAME;
  const from = `${name} <${addr}>`;
  // Log the token link ONLY in local development. Every deployed environment
  // (production AND staging) sets a concrete `ENVIRONMENT`, so a single-use token
  // is never written to a shared log sink.
  const logLink = !env.ENVIRONMENT || env.ENVIRONMENT === "development";

  if (!env.AUTH_EMAIL) {
    logEvent("warn", {
      component: "auth",
      event: "email-no-binding",
      message: `AUTH_EMAIL binding absent; "${msg.subject}" not sent to ${msg.to}`,
      // The link lives in the body — local dev only, so the flow can be finished
      // from logs; never logged in a deployed env (single-use token).
      ...(logLink ? { body: msg.text } : {}),
      environment: env.ENVIRONMENT,
    });
    return { sent: false, reason: "no_binding" };
  }

  try {
    const res = await env.AUTH_EMAIL.send({
      to: msg.to,
      from,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    logEvent("info", {
      component: "auth",
      event: "email-sent",
      message: `Sent "${msg.subject}" to ${msg.to}`,
      environment: env.ENVIRONMENT,
    });
    return { sent: true, messageId: res?.messageId };
  } catch (err) {
    logEvent("error", {
      component: "auth",
      event: "email-send-failed",
      message: `Failed to send "${msg.subject}" to ${msg.to}`,
      error: err instanceof Error ? err.message : String(err),
      // Single-use token in the body: local dev only (see above).
      ...(logLink ? { body: msg.text } : {}),
      environment: env.ENVIRONMENT,
    });
    return { sent: false, reason: "error" };
  }
}

/** Verification email shown on sign-up / re-sent on an unverified sign-in. */
export function verifyEmailTemplate(opts: { url: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = "Verify your email for Releases";
  const text = [
    "Welcome to Releases.",
    "",
    "Confirm your email address to finish setting up your account:",
    opts.url,
    "",
    "This link expires in 1 hour. If you didn't create an account, you can ignore this email.",
  ].join("\n");
  const html = [
    "<p>Welcome to Releases.</p>",
    "<p>Confirm your email address to finish setting up your account:</p>",
    `<p><a href="${opts.url}">Verify email</a></p>`,
    "<p>This link expires in 1 hour. If you didn't create an account, you can ignore this email.</p>",
  ].join("");
  return { subject, text, html };
}

/** Password-reset email triggered by the forgot-password flow. */
export function resetPasswordTemplate(opts: { url: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = "Reset your Releases password";
  const text = [
    "We received a request to reset your Releases password.",
    "",
    "Reset it here:",
    opts.url,
    "",
    "This link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.",
  ].join("\n");
  const html = [
    "<p>We received a request to reset your Releases password.</p>",
    `<p><a href="${opts.url}">Reset password</a></p>`,
    "<p>This link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.</p>",
  ].join("");
  return { subject, text, html };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test workers/api/test/auth-email.test.ts`
Expected: PASS (3 + 2 assertions across 5 tests).

- [ ] **Step 5: Type-check the worker**

Run: `npx tsc --noEmit -p workers/api/tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/auth/email.ts workers/api/test/auth-email.test.ts
git commit -m "feat(auth): sendAuthEmail helper + verify/reset email templates"
```

---

## Task 2: Wire verification + reset into `createAuth` (with exec-ctx `waitUntil`)

**Files:**

- Modify: `workers/api/src/auth/index.ts`
- Modify: `workers/api/test/auth.test.ts`
- Modify: `workers/api/src/index.ts:10` (import) and `:377-380` (route handler) and the `Env` block (`:286-292`)

- [ ] **Step 1: Write the failing integration test**

In `workers/api/test/auth.test.ts`, extend the existing import from `../src/auth/index.js` to add `createAuth`, and add an import for the email message type. The current import is:

```ts
import {
  buildSocialProviders,
  authTrustedOrigins,
  authCorsMiddleware,
  deriveCookieDomain,
} from "../src/auth/index.js";
```

Replace it with:

```ts
import {
  buildSocialProviders,
  authTrustedOrigins,
  authCorsMiddleware,
  deriveCookieDomain,
  createAuth,
} from "../src/auth/index.js";
import type { AuthEmailMessage } from "../src/auth/email.js";
```

Then append this `describe` block to the end of the file:

```ts
// ── Integration: the email-verification gate ──
// Builds the REAL createAuth() over the migrated test DB with an injected
// capturing email sender (no network). Proves requireEmailVerification blocks
// the session at sign-up and fires the verification email, and that an
// unverified sign-in is rejected.

describe("email verification gate", () => {
  const env = {
    BETTER_AUTH_URL: "https://api.releases.localhost",
    BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
  } as never;

  it("sign-up creates NO session and fires a verification email", async () => {
    const db = createTestDb();
    const captured: AuthEmailMessage[] = [];
    const auth = await createAuth(env, {
      db,
      sendEmail: (m) => {
        captured.push(m);
      },
    });

    await auth.api.signUpEmail({
      body: { email: "dora@example.com", password: "correct-horse-battery", name: "Dora" },
    });

    // requireEmailVerification → no session row at sign-up.
    const sessions = await db.select().from(session);
    expect(sessions).toHaveLength(0);
    // user row exists but unverified.
    const users = await db.select().from(user);
    expect(users).toHaveLength(1);
    expect(users[0]?.emailVerified).toBeFalsy();
    // a verification email was scheduled to the new address with a token link.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.to).toBe("dora@example.com");
    expect(captured[0]?.text).toMatch(/verify-email|token=/);
  });

  it("rejects sign-in while the email is unverified", async () => {
    const db = createTestDb();
    const auth = await createAuth(env, { db, sendEmail: () => {} });
    await auth.api.signUpEmail({
      body: { email: "evan@example.com", password: "correct-horse-battery", name: "Evan" },
    });
    await expect(
      auth.api.signInEmail({
        body: { email: "evan@example.com", password: "correct-horse-battery" },
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test workers/api/test/auth.test.ts`
Expected: FAIL — `createAuth` does not accept a second `deps` argument / sign-up still creates a session (the existing config has no `requireEmailVerification`). A TypeScript error on the `{ db, sendEmail }` arg is also acceptable as a "fail".

- [ ] **Step 3: Add the exec-ctx seam + injectable deps to `createAuth`**

In `workers/api/src/auth/index.ts`, add imports at the top (after the existing imports):

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import {
  sendAuthEmail,
  verifyEmailTemplate,
  resetPasswordTemplate,
  type AuthEmailMessage,
} from "./email.js";
```

Add this block above `createAuth` (after `authCorsMiddleware`):

```ts
/**
 * Carries the Worker `ExecutionContext` into the per-request auth instance so the
 * email hooks can `waitUntil` their send. The hooks must NOT `await` the send (the
 * Better Auth docs flag awaiting as a timing-attack surface) but on Workers a bare
 * floating promise is cancelled when the response returns — `waitUntil` keeps it
 * alive. The `/api/auth/*` route runs `auth.handler` inside `runWithExecCtx`.
 */
const execCtxStore = new AsyncLocalStorage<ExecutionContext>();

/** Run `fn` with `ctx` available to the auth email hooks via `execCtxStore`. */
export function runWithExecCtx<T>(ctx: ExecutionContext, fn: () => T): T {
  return execCtxStore.run(ctx, fn);
}

/**
 * Fire-and-forget a side effect (email send): `waitUntil` it when an
 * `ExecutionContext` is in scope (production request), else run it inline. Tests
 * and direct `auth.api` calls have no ctx — running inline keeps them
 * deterministic (the injected capturing sender records synchronously).
 */
function scheduleSend(run: () => Promise<unknown>): void {
  const ctx = execCtxStore.getStore();
  if (ctx) ctx.waitUntil(run());
  else void run();
}

/** Send a fully-rendered auth email. Injectable so tests can capture without I/O. */
export type AuthEmailSender = (msg: AuthEmailMessage) => void | Promise<void>;

export interface CreateAuthDeps {
  /** DB handle — tests pass `createTestDb()`; defaults to `createDb(env.DB)`. */
  db?: ReturnType<typeof createDb>;
  /** Email sender — tests capture; defaults to the real `sendAuthEmail`. */
  sendEmail?: AuthEmailSender;
}
```

Change the `createAuth` signature and body. The current signature is:

```ts
export async function createAuth(env: Bindings) {
```

Replace with:

```ts
export async function createAuth(env: Bindings, deps: CreateAuthDeps = {}) {
```

Inside `createAuth`, just before the `return betterAuth({` line, add:

```ts
const db = deps.db ?? createDb(env.DB);
const sendEmail: AuthEmailSender = deps.sendEmail ?? ((msg) => sendAuthEmail(env, msg));
```

Then replace the entire `return betterAuth({ ... });` object with:

```ts
return betterAuth({
  appName: "Releases",
  secret,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: authTrustedOrigins(env),
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema: { user, session, account, verification },
  }),
  emailAndPassword: {
    enabled: true,
    // Block sign-in until the email is verified. Sign-up returns a success
    // response with NO session (also enables Better Auth's enumeration
    // protection), and each unverified sign-in attempt re-sends the link.
    requireEmailVerification: true,
    // Resetting a password kills the user's other sessions.
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user: u, url }) => {
      const msg: AuthEmailMessage = { to: u.email, ...resetPasswordTemplate({ url }) };
      scheduleSend(() => Promise.resolve(sendEmail(msg)));
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user: u, url }) => {
      const msg: AuthEmailMessage = { to: u.email, ...verifyEmailTemplate({ url }) };
      scheduleSend(() => Promise.resolve(sendEmail(msg)));
    },
  },
  socialProviders,
  advanced: {
    // Engage cross-subdomain cookies only when a real cookie domain is
    // derivable (prod `.releases.sh`, local portless `.releases.localhost`).
    // On bare loopback the host is single-label and no domain resolves —
    // leave it OFF so Better Auth sets a clean host-only cookie shared across
    // `localhost` ports. See `authTrustedOrigins` for the local OAuth rationale.
    crossSubDomainCookies: cookieDomain
      ? { enabled: true, domain: cookieDomain }
      : { enabled: false },
    // Route Better Auth's own deferred work through `waitUntil` on Workers.
    backgroundTasks: {
      handler: (p) => {
        const ctx = execCtxStore.getStore();
        if (ctx) ctx.waitUntil(p);
      },
    },
  },
});
```

> Note: the existing `database: drizzleAdapter(createDb(env.DB), …)` is now `drizzleAdapter(db, …)` using the local `db`. The `??` short-circuits, so `createDb(env.DB)` is only evaluated when `deps.db` is absent — tests that pass `deps.db` never call it (sidestepping the makeD1Shim read limitation).

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `bun test workers/api/test/auth.test.ts`
Expected: PASS — including the existing email/password block (those tests build their own `betterAuth` without `requireEmailVerification`, so they're unaffected) and the two new gate tests.

> If the first new test is flaky (capture empty), the hook ran async after `signUpEmail` resolved — add `await new Promise((r) => setTimeout(r, 0));` before the `captured` assertions. Don't add it pre-emptively; the injected sender records synchronously, so it should pass without.

- [ ] **Step 5: Thread the exec-ctx into the route handler + add `Env` fields**

In `workers/api/src/index.ts`, update the auth import (line ~10):

```ts
import { createAuth, authCorsMiddleware, runWithExecCtx } from "./auth/index.js";
```

Add a type import near the other top-level imports:

```ts
import type { AuthEmailBinding } from "./auth/email.js";
```

Replace the auth route handler (currently at ~line 377):

```ts
app.on(["POST", "GET"], "/api/auth/*", async (c) => {
  const auth = await createAuth(c.env);
  return auth.handler(c.req.raw);
});
```

with:

```ts
app.on(["POST", "GET"], "/api/auth/*", async (c) => {
  const auth = await createAuth(c.env);
  // Run inside the exec-ctx scope so the verification/reset email hooks can
  // `waitUntil` their send (fire-and-forget without awaiting). See src/auth/index.ts.
  return runWithExecCtx(c.executionCtx, () => auth.handler(c.req.raw));
});
```

In the `Env["Bindings"]` block, immediately after the `GITHUB_CLIENT_SECRET` line (~line 292), add:

```ts
    // Cloudflare Email Sending binding for USER-FACING auth mail (verification +
    // password reset). Object-form send → arbitrary recipients. Distinct from
    // SEND_EMAIL (Email Routing, internal-only, verified-destinations). Absent →
    // sendAuthEmail logs the link and no-ops (local `wrangler dev` simulates sends).
    AUTH_EMAIL?: AuthEmailBinding;
    // Sender address + display name for AUTH_EMAIL. Default noreply@releases.sh / "Releases".
    AUTH_EMAIL_FROM?: string;
    AUTH_EMAIL_FROM_NAME?: string;
```

- [ ] **Step 6: Type-check the worker**

Run: `npx tsc --noEmit -p workers/api/tsconfig.json`
Expected: no errors. (If `node:async_hooks` / `AsyncLocalStorage` is unresolved, confirm `@types/node` is in the worker's dev deps and `nodejs_compat` is on — it is per the stub design — and that `compilerOptions.types`/`lib` doesn't exclude node. Add `"node"` to `types` only if needed.)

- [ ] **Step 7: Run the whole worker auth suite + commit**

Run: `bun test workers/api/test/auth.test.ts workers/api/test/auth-email.test.ts`
Expected: PASS.

```bash
git add workers/api/src/auth/index.ts workers/api/src/index.ts workers/api/test/auth.test.ts
git commit -m "feat(auth): require email verification + password reset hooks (waitUntil-backed)"
```

---

## Task 3: `wrangler.jsonc` — `AUTH_EMAIL` binding + sender vars

**Files:**

- Modify: `workers/api/wrangler.jsonc` (prod `send_email` ~line 234, prod `vars` ~line 80; staging `send_email` ~line 573, staging `vars` ~line 497)

- [ ] **Step 1: Add the prod binding**

Replace (line ~234):

```jsonc
  "send_email": [{ "name": "SEND_EMAIL" }],
```

with:

```jsonc
  // Two Email bindings. SEND_EMAIL = Email Routing (internal ops notifications,
  // reaches only account-verified destinations). AUTH_EMAIL = Email Sending
  // (user-facing verification + password-reset mail to arbitrary recipients),
  // sender-locked to noreply@releases.sh. Requires Email Sending enabled on the
  // account + releases.sh verified for Email Sending (DKIM) — see the spec.
  "send_email": [
    { "name": "SEND_EMAIL" },
    { "name": "AUTH_EMAIL", "allowed_sender_addresses": ["noreply@releases.sh"] },
  ],
```

- [ ] **Step 2: Add the prod sender vars**

After the `"EMAIL_FROM": "notifications@releases.sh",` line (~line 80), add:

```jsonc
    // Sender for user-facing auth email (AUTH_EMAIL binding; see src/auth/email.ts).
    "AUTH_EMAIL_FROM": "noreply@releases.sh",
    "AUTH_EMAIL_FROM_NAME": "Releases",
```

- [ ] **Step 3: Add the staging binding**

Replace (line ~573, inside `[env.staging]`):

```jsonc
      "send_email": [{ "name": "SEND_EMAIL" }],
```

with:

```jsonc
      "send_email": [
        { "name": "SEND_EMAIL" },
        { "name": "AUTH_EMAIL", "allowed_sender_addresses": ["noreply@releases.sh"] },
      ],
```

- [ ] **Step 4: Add the staging sender vars**

After the staging `"EMAIL_FROM": "notifications@releases.sh",` line (~line 497), add:

```jsonc
        "AUTH_EMAIL_FROM": "noreply@releases.sh",
        "AUTH_EMAIL_FROM_NAME": "Releases",
```

- [ ] **Step 5: Validate the config parses**

Run: `npx wrangler deploy --dry-run --config workers/api/wrangler.jsonc 2>&1 | tail -20`
Expected: a dry-run summary listing the bindings (including two `send_email` entries `SEND_EMAIL` and `AUTH_EMAIL`) with no JSONC parse error. (A warning about Email Sending being beta is fine. If `--dry-run` needs auth/account it can't reach here, it's acceptable to instead just confirm the JSONC parses, e.g. `node -e "require('jsonc-parser')"`-style or a `tsc` run; the binding takes effect on the real deploy.)

- [ ] **Step 6: Commit**

```bash
git add workers/api/wrangler.jsonc
git commit -m "feat(auth): add AUTH_EMAIL Email Sending binding + sender vars (prod + staging)"
```

---

## Task 4: Web auth-client re-exports

**Files:**

- Modify: `web/src/lib/auth-client.ts`

- [ ] **Step 1: Add the re-exports**

Replace the final export line:

```ts
export const { signIn, signUp, signOut, useSession, getSession } = authClient;
```

with:

```ts
export const {
  signIn,
  signUp,
  signOut,
  useSession,
  getSession,
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
} = authClient;
```

- [ ] **Step 2: Type-check the web app**

Run: `npx tsc --noEmit -p web/tsconfig.json`
Expected: no errors (the three methods exist on the `better-auth/react` client).

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/auth-client.ts
git commit -m "feat(auth): re-export password-reset + sendVerificationEmail client methods"
```

---

## Task 5: `AuthForm` — check-email state, 403 resend, forgot-password link

**Files:**

- Modify: `web/src/components/auth-form.tsx`

- [ ] **Step 1: Update imports**

Change the auth-client import line:

```ts
import { signIn, signUp } from "@/lib/auth-client";
```

to:

```ts
import { signIn, signUp, sendVerificationEmail } from "@/lib/auth-client";
```

- [ ] **Step 2: Add the post-submit state**

Inside `AuthForm`, after the existing `const [showPassword, setShowPassword] = useState(false);` line, add:

```tsx
// After a sign-up, the user has NO session (verification is required) — show a
// "check your email" panel instead of redirecting. On an unverified sign-in the
// worker returns 403 and re-sends the link; show the same panel with a resend.
const [pendingEmail, setPendingEmail] = useState<string | null>(null);
const [phase, setPhase] = useState<"form" | "check-email">("form");
const [resent, setResent] = useState(false);

// Absolute callback URL on THIS web origin — the verify link redirects here
// after the worker verifies + auto-signs-in (a relative URL would resolve
// against the worker's baseURL and strand the user on api.releases.sh).
function callbackURL(): string {
  return new URL(target, window.location.origin).toString();
}

async function resend() {
  if (!pendingEmail || busy) return;
  setError(null);
  setPending(true);
  try {
    await sendVerificationEmail({ email: pendingEmail, callbackURL: callbackURL() });
    setResent(true);
  } catch {
    setError("Could not resend the email. Please try again.");
  } finally {
    setPending(false);
  }
}
```

- [ ] **Step 3: Replace `onSubmit`**

Replace the whole `onSubmit` function with:

```tsx
async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault();
  if (busy) return;
  const data = new FormData(event.currentTarget);
  const email = String(data.get("email") ?? "").trim();
  const password = String(data.get("password") ?? "");
  setError(null);
  setPending(true);
  try {
    if (mode === "signup") {
      const result = await signUp.email({
        name: String(data.get("name") ?? "").trim(),
        email,
        password,
        callbackURL: callbackURL(),
      });
      if (result.error) {
        setError(prettyError(result.error, mode));
        return;
      }
      // No session yet — email verification is required. Show the panel.
      setPendingEmail(email);
      setPhase("check-email");
      return;
    }

    const result = await signIn.email({ email, password });
    if (result.error) {
      // 403 = email not verified. The worker has re-sent the link; surface the
      // check-email panel rather than a raw error.
      if (result.error.status === 403) {
        setPendingEmail(email);
        setResent(true);
        setPhase("check-email");
        return;
      }
      setError(prettyError(result.error, mode));
      return;
    }
    router.push(target);
    router.refresh();
  } catch {
    setError("Network error. Please try again.");
  } finally {
    setPending(false);
  }
}
```

- [ ] **Step 4: Render the check-email panel**

At the very top of the returned JSX (immediately after `return (` and before `<div className="space-y-6">` — actually replace the opening so the panel short-circuits), wrap the existing markup. Replace:

```tsx
  return (
    <div className="space-y-6">
```

with:

```tsx
  if (phase === "check-email") {
    return (
      <div className="space-y-5">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
            Check your email
          </p>
          <h2 className="mt-3 text-lg font-semibold tracking-tight text-stone-900 dark:text-stone-100">
            Verify your email address
          </h2>
          <p className="mt-3 text-sm leading-6 text-stone-500 dark:text-stone-400">
            {pendingEmail ? (
              <>
                We sent a verification link to{" "}
                <span className="font-medium text-stone-700 dark:text-stone-200">{pendingEmail}</span>
                . Click it to finish signing in. {resent ? "We just sent a fresh link." : null}
              </>
            ) : (
              "We sent you a verification link. Click it to finish signing in."
            )}
          </p>
        </div>
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={resend}
          disabled={busy}
          className="inline-flex h-10 items-center justify-center border border-stone-300 bg-white px-4 text-sm font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900"
        >
          {pending ? "Sending..." : "Resend verification email"}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
```

- [ ] **Step 5: Add the "Forgot password?" link (login mode)**

In the login-mode footer paragraph, add a forgot link. Find the password field block; immediately after the closing `</div>` of the password field's outer wrapper (the `<div>` that contains the `<label htmlFor="password">` … and the show/hide button), insert, **only in login mode**:

```tsx
{
  mode === "login" && (
    <p className="-mt-2 text-right text-sm">
      <Link
        href="/forgot-password"
        className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
      >
        Forgot password?
      </Link>
    </p>
  );
}
```

(Place it between the password `<div>…</div>` block and the `{error && (…)}` block so it sits under the password field.)

- [ ] **Step 6: Type-check the web app**

Run: `npx tsc --noEmit -p web/tsconfig.json`
Expected: no errors. (`result.error.status` is typed on the Better Auth client error; `Link` is already imported.)

- [ ] **Step 7: Commit**

```bash
git add web/src/components/auth-form.tsx
git commit -m "feat(auth): check-email state, unverified-resend, and forgot-password link"
```

---

## Task 6: `/forgot-password` + `/reset-password` pages

**Files:**

- Create: `web/src/components/forgot-password-form.tsx`
- Create: `web/src/components/reset-password-form.tsx`
- Create: `web/src/app/forgot-password/page.tsx`
- Create: `web/src/app/reset-password/page.tsx`

- [ ] **Step 1: Create the forgot-password form**

Create `web/src/components/forgot-password-form.tsx`:

```tsx
"use client";

import { useState } from "react";
import { requestPasswordReset } from "@/lib/auth-client";

const inputClass =
  "mt-2 w-full border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-2.5 text-sm text-stone-900 dark:text-stone-100 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20";
const labelClass =
  "block text-[11px] font-medium uppercase tracking-[0.18em] text-stone-500 dark:text-stone-400";

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    setError(null);
    setPending(true);
    try {
      // The reset link redirects back to /reset-password on THIS origin with the
      // token in the query (absolute — it must not resolve against the worker).
      const redirectTo = new URL("/reset-password", window.location.origin).toString();
      await requestPasswordReset({ email, redirectTo });
      // Enumeration-safe: always show the same confirmation.
      setSent(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <p className="text-sm leading-6 text-stone-500 dark:text-stone-400">
        If an account exists for that email, we&apos;ve sent a password reset link. Check your
        inbox.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div>
        <label htmlFor="email" className={labelClass}>
          Email <span className="text-blue-500">*</span>
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          className={inputClass}
        />
      </div>
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-10 w-full items-center justify-center bg-stone-950 px-4 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-white"
      >
        {pending ? "Sending..." : "Send reset link"}
      </button>
    </form>
  );
}
```

- [ ] **Step 2: Create the reset-password form**

Create `web/src/components/reset-password-form.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { resetPassword } from "@/lib/auth-client";

const inputClass =
  "mt-2 w-full border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-2.5 text-sm text-stone-900 dark:text-stone-100 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20";
const labelClass =
  "block text-[11px] font-medium uppercase tracking-[0.18em] text-stone-500 dark:text-stone-400";

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const newPassword = String(new FormData(event.currentTarget).get("password") ?? "");
    setError(null);
    setPending(true);
    try {
      const result = await resetPassword({ newPassword, token });
      if (result.error) {
        setError(
          result.error.message ?? "Could not reset your password. The link may have expired.",
        );
        return;
      }
      router.push("/login?reset=1");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div>
        <label htmlFor="password" className={labelClass}>
          New password <span className="text-blue-500">*</span>
        </label>
        <div className="relative">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="At least 8 characters"
            className={`${inputClass} pr-16`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-[11px] font-medium uppercase tracking-wider text-stone-400 transition hover:text-stone-600 dark:hover:text-stone-300"
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-10 w-full items-center justify-center bg-stone-950 px-4 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-white"
      >
        {pending ? "Resetting..." : "Reset password"}
      </button>
    </form>
  );
}
```

- [ ] **Step 3: Create the forgot-password page**

Create `web/src/app/forgot-password/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Header } from "@/components/header";
import { ForgotPasswordForm } from "@/components/forgot-password-form";
import { AUTH_UI_ENABLED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Reset password",
  description: "Reset your releases.sh account password.",
  alternates: { canonical: "/forgot-password" },
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  if (!AUTH_UI_ENABLED) notFound();

  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-12 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="text-sm text-stone-500 dark:text-stone-400">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
            Account
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
            Reset your password
          </h1>
          <p className="mt-4 leading-6">
            Enter your email and we&apos;ll send you a link to set a new password. Remembered it?{" "}
            <Link
              href="/login"
              className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
            >
              Sign in
            </Link>
            .
          </p>
        </aside>

        <section className="border border-stone-200 bg-stone-50 p-5 dark:border-stone-800 dark:bg-stone-950 sm:p-6">
          <ForgotPasswordForm />
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create the reset-password page**

Create `web/src/app/reset-password/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Header } from "@/components/header";
import { ResetPasswordForm } from "@/components/reset-password-form";
import { AUTH_UI_ENABLED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Set a new password",
  description: "Set a new password for your releases.sh account.",
  alternates: { canonical: "/reset-password" },
  robots: { index: false, follow: false },
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  if (!AUTH_UI_ENABLED) notFound();
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : undefined;
  const hasError = Boolean(params.error) || !token;

  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-12 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="text-sm text-stone-500 dark:text-stone-400">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
            Account
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
            Set a new password
          </h1>
          <p className="mt-4 leading-6">Choose a new password for your releases.sh account.</p>
        </aside>

        <section className="border border-stone-200 bg-stone-50 p-5 dark:border-stone-800 dark:bg-stone-950 sm:p-6">
          {hasError ? (
            <p className="text-sm leading-6 text-stone-500 dark:text-stone-400">
              This password reset link is invalid or has expired.{" "}
              <Link
                href="/forgot-password"
                className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
              >
                Request a new one
              </Link>
              .
            </p>
          ) : (
            <ResetPasswordForm token={token!} />
          )}
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Type-check the web app**

Run: `npx tsc --noEmit -p web/tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/forgot-password-form.tsx web/src/components/reset-password-form.tsx web/src/app/forgot-password/page.tsx web/src/app/reset-password/page.tsx
git commit -m "feat(auth): forgot-password + reset-password pages"
```

---

## Task 7: Full verification + live smoke

**Files:** none (verification only)

- [ ] **Step 1: Type-check everything**

Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p workers/api/tsconfig.json
npx tsc --noEmit -p web/tsconfig.json
```

Expected: no errors from any of the three.

- [ ] **Step 2: Run the test suite**

Run: `bun test workers/api/test/auth.test.ts workers/api/test/auth-email.test.ts`
Expected: PASS. Then a broader sanity run: `bun test workers/api` — expect no new failures.

- [ ] **Step 3: Lint + format**

Run:

```bash
bun run lint
bun run format:check
```

Expected: clean. If `format:check` flags the new files, run `bun run format` and amend the relevant commit.

- [ ] **Step 4: Live smoke (local `wrangler dev`)**

Prereqs (from `project_better_auth_stub` runbook): portless `--tld dev`, the three env files, the local D1 migration applied, and `NEXT_PUBLIC_AUTH_UI_ENABLED=true` in `web/.env.local`. `AUTH_EMAIL` will be **absent** locally (or simulate), so `sendAuthEmail` logs the link — grab it from the `wrangler dev` console output.

Verification flow:

1. Go to `/signup`, create an account → the form shows **"Verify your email address"** (no redirect, no session).
2. In the worker logs, find the `auth` / `email-no-binding` (or `email-sent`) event and copy the `verify-email?token=…` URL from `body`.
3. Open that URL → you're redirected back to the web app and **signed in** (session cookie on `.releases.localhost`; the account nav shows signed-in state).

Reset flow: 4. Sign out. On `/login`, click **"Forgot password?"** → enter the email → see the enumeration-safe confirmation. 5. Copy the `reset-password?token=…` URL from the worker logs → open it → `/reset-password` renders the new-password form. 6. Set a new password → redirected to `/login?reset=1` → sign in with the new password succeeds.

Unverified sign-in: 7. Create a second account but do NOT verify it; try to sign in → the **check-email panel** appears ("we just sent a fresh link"), and a new verify link is in the logs.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin worktree-better-auth-email
gh pr create --title "feat(auth): email verification + password reset" --body-file <(cat <<'EOF'
Closes prod blocker #1 from the Better Auth handoff: email/password sign-up now
requires email verification before a session is created, and adds a forgot/reset
flow. Both emails send via Cloudflare Email Sending (new `AUTH_EMAIL` binding).

Spec: docs/superpowers/specs/2026-06-04-better-auth-email-verification-reset-design.md

## Before this is enabled in prod (operator)
- Enable **Email Sending** on the Cloudflare account (beta) and verify **releases.sh**
  for Email Sending (DKIM). Until then sends are caught + logged (no 500s).
- Auth UI stays dark until `NEXT_PUBLIC_AUTH_UI_ENABLED=true` (separate handoff step).

## Out of scope
Auth-endpoint rate limiting (the other prod blocker), account linking, 2FA.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)
```

---

## Self-review

**Spec coverage:**

- Strict gate (block sign-in until verified) → Task 2 (`requireEmailVerification`, `sendOnSignUp`, `autoSignInAfterVerification`) + integration test.
- Password reset → Task 2 (`sendResetPassword`, `revokeSessionsOnPasswordReset`) + Tasks 4–6 (client + pages).
- CF Email Sending dedicated binding → Task 3; helper → Task 1.
- `waitUntil`/`AsyncLocalStorage` → Task 2 (`runWithExecCtx`, `scheduleSend`, `backgroundTasks`).
- No migration → confirmed (no `schema-auth.ts` change in any task; the schema-pairing gate stays green).
- Web: check-email state, 403 resend, forgot link, two pages → Tasks 5–6.
- Local-dev log fallback + tests → Task 1 + Task 7.
- Config-ownership split (operator vs code) → Task 3 + PR body.

**Placeholder scan:** none — every code step has complete code; commands have expected output.

**Type consistency:** `AuthEmailMessage` / `AuthEmailBinding` defined in Task 1 are imported unchanged in Task 2 and the `Env` block; `createAuth(env, deps)`, `CreateAuthDeps`, `runWithExecCtx`, `scheduleSend`, `AuthEmailSender` are all defined in Task 2 before use; `requestPasswordReset` / `resetPassword` / `sendVerificationEmail` re-exported in Task 4 are consumed in Tasks 5–6; binding name `AUTH_EMAIL` is identical across Task 1 (interface), Task 2 (`Env`), and Task 3 (wrangler).
