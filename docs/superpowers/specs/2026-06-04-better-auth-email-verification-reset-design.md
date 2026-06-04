# 2026-06-04 — Better Auth: email verification + password reset

Approved in-session design. Builds on the merged Better Auth stub (#1402 → #1417),
which is live but **dark** in prod (`NEXT_PUBLIC_AUTH_UI_ENABLED` unset). This pass
closes prod blocker #1 from the auth handoff: email/password signup currently lets
anyone create an account with an unverified email. Adds a **strict** email-verification
gate and folds in the **password-reset** flow (it reuses the same email sender).

The _other_ prod blocker — auth-endpoint rate limiting — is **out of scope here** (see
§9). It stays a separate task.

## Goal

- Email/password sign-up sends a verification link; **a session is not created until
  the email is verified** (block sign-in until verified).
- Signed-out users can reset a forgotten password via emailed link.
- Verification/reset email is sent through **Cloudflare Email Sending** (the new
  transactional product under "Cloudflare Email Service"), which — unlike the Email
  Routing `send_email` binding the repo already uses for internal alerts — delivers to
  **arbitrary recipients** (any new-signup address), not just account-verified ones.

## Decisions (settled during brainstorming)

1. **Provider: Cloudflare Email Sending.** Native to the stack, no third-party vendor,
   no API-key secret. Public beta (Apr 2026), Workers Paid plan (already in use).
   Sends via the object-form `env.AUTH_EMAIL.send({ to, from, subject, html, text })`.
2. **Strict gate: block sign-in until verified.** `requireEmailVerification: true`.
   Signup creates no session; the user must click the link (which auto-signs them in).
3. **Scope: verification + password reset.** Reset reuses the same email helper; the
   marginal backend cost is one Better Auth hook + two web pages.

## Behavior

### Sign-up → verify (blocking)

```mermaid
sequenceDiagram
    participant U as User (web)
    participant W as API worker (api.releases.sh)
    participant E as CF Email Sending
    U->>W: POST /api/auth/sign-up/email {name,email,password,callbackURL}
    W->>W: create user (emailVerified=0), NO session (enumeration-safe 200)
    W-)E: sendVerificationEmail (via waitUntil; link → /api/auth/verify-email?token&callbackURL)
    W-->>U: 200, no session
    U->>U: form shows "Check your email"
    U->>W: GET /api/auth/verify-email?token=…&callbackURL=…
    W->>W: validate token → emailVerified=1 → create session (auto-sign-in)
    W-->>U: 302 Set-Cookie (.releases.sh) → callbackURL (absolute web URL)
    U->>U: lands signed in
```

- `signUp.email({ name, email, password, callbackURL })` — `callbackURL` is an
  **absolute web URL** (`new URL(target, window.location.origin)`), same reason as the
  existing social-callback fix: a relative URL resolves against the worker's `baseURL`
  and would strand the user on `api.releases.sh`.
- Config: `emailVerification.sendOnSignUp: true`, `requireEmailVerification: true`,
  `autoSignInAfterVerification: true`.
- **Enumeration protection is automatic** with `requireEmailVerification: true` — an
  already-registered email also gets a 200 with no session, so the "check your email"
  UX is uniform and leaks nothing.

### Sign-in with an unverified account

- `signIn.email` returns **403**; the worker re-sends the verification email.
- The form detects 403 and shows "Verify your email — we sent a new link," with a
  **Resend** action wired to `authClient.sendVerificationEmail({ email, callbackURL })`.

### Social login is unaffected

- Google/GitHub emails are provider-trusted (`emailVerified` set true), and
  `requireEmailVerification` only gates the email/password path. No verification prompt
  for social users. (Social providers remain credential-gated/off until their secrets
  are set — unchanged from the stub.)

### Forgot → reset

```mermaid
sequenceDiagram
    participant U as User (web)
    participant W as API worker
    participant E as CF Email Sending
    U->>W: POST /api/auth/request-password-reset {email, redirectTo}
    W-)E: sendResetPassword (via waitUntil; link → worker, then redirect to redirectTo)
    W-->>U: 200 ("if that account exists, we sent a link")
    U->>W: GET email link → worker validates token
    W-->>U: 302 → redirectTo?token=… (or ?error=INVALID_TOKEN)
    U->>U: /reset-password reads token, shows new-password form
    U->>W: POST /api/auth/reset-password {newPassword, token}
    W->>W: set password, revoke other sessions
    W-->>U: 200 → redirect to /login with notice
```

- `/login` gains a **"Forgot password?"** link → new `/forgot-password` page.
- `authClient.requestPasswordReset({ email, redirectTo })` — `redirectTo` is an absolute
  web URL (`https://releases.sh/reset-password`). Always show the same enumeration-safe
  copy regardless of whether the email exists.
- New `/reset-password` page reads `?token` (or `?error=INVALID_TOKEN`) from the query →
  `authClient.resetPassword({ newPassword, token })`. Success → `/login` with a notice.
- `revokeSessionsOnPasswordReset: true` — resetting a password kills other sessions.

## Architecture

### Email sender

- **Dedicated binding `AUTH_EMAIL`** (a second `send_email` binding, distinct from the
  existing `SEND_EMAIL`). Why dedicated rather than reusing `SEND_EMAIL`:
  - Clear separation of intent — user-facing auth mail vs. internal ops notifications.
  - Sender lock-down via `allowed_sender_addresses: ["noreply@releases.sh"]`.
  - Independent observability; auth mail is not coupled to the `EMAIL_NOTIFY_ENABLED`
    kill switch that governs internal notifications.
  - (`send_email` is the same binding _type_ for both Email Routing and Email Sending;
    arbitrary-recipient capability comes from Email Sending being enabled on the account
    plus a verified sending domain — not from the binding name. A dedicated handle
    documents intent and constrains the sender.)
- **`sendAuthEmail(env, { to, subject, text, html })`** — new helper in
  `workers/api/src/auth/email.ts`:
  - Guards on the `AUTH_EMAIL` binding; absent → log the link via `logEvent` and return
    `{ sent: false, reason }` (lets local dev complete the flow from logs).
  - Calls the object-form `env.AUTH_EMAIL.send({ to, from, subject, html, text })`.
  - **Never throws** — wraps the send in try/catch → `logEvent("error", …)` on failure
    so a beta hiccup or unverified domain degrades gracefully instead of surfacing as an
    unhandled rejection inside Better Auth's request flow.
  - **Always logs** the verification/reset URL (info) so a local `wrangler dev` run —
    which _simulates_ sends (logs, doesn't deliver) — can finish the flow by copy-pasting
    the URL from Worker logs. No real sending required to test locally.
  - `from` = `env.AUTH_EMAIL_FROM` (default `noreply@releases.sh`); display name
    `env.AUTH_EMAIL_FROM_NAME` (default `Releases`).
  - Template builders `verifyEmailTemplate({ url })` / `resetPasswordTemplate({ url })`
    return `{ subject, text, html }` (branded, plain-text + minimal HTML).

### `waitUntil` (don't await the send)

Better Auth's documented Cloudflare Workers pattern — the email hooks must **not**
`await` the send (timing-attack surface) but the send must outlive the response:

- Module-level `AsyncLocalStorage<ExecutionContext>` in `workers/api/src/auth/index.ts`
  (`node:async_hooks`; `nodejs_compat` is already on).
- The `/api/auth/*` route handler runs `auth.handler` inside
  `execCtxStore.run(c.executionCtx, () => auth.handler(c.req.raw))`.
- `advanced.backgroundTasks.handler = (p) => execCtxStore.getStore()?.waitUntil(p)` —
  routes Better Auth's own deferred work through `waitUntil` too.
- The `sendVerificationEmail` / `sendResetPassword` hooks schedule the send via the same
  store: `execCtxStore.getStore()?.waitUntil(sendAuthEmail(...))`, falling back to
  `void sendAuthEmail(...)` when there is no ctx (unit tests / `auth.api` calls).

### No database migration

Reuses the existing `verification` table (Better Auth's shared token store — holds both
email-verification and password-reset tokens) and the `user.email_verified` column. No
`schema-auth.ts` change → the schema↔migration pairing CI gate does not trip.

## Components / files

**Server (`workers/api/`)**

- `src/auth/email.ts` _(new)_ — `sendAuthEmail` + `verifyEmailTemplate` /
  `resetPasswordTemplate`. Minimal local binding interface
  `AuthEmailBinding { send(msg: { to; from; subject; html?; text? }): Promise<{ messageId?: string }> }`
  (avoids depending on beta `@cloudflare/workers-types` overloads).
- `src/auth/index.ts` — extend `createAuth`:
  - `appName: "Releases"`.
  - `emailVerification: { sendVerificationEmail, sendOnSignUp: true, autoSignInAfterVerification: true }`
    (token TTL stays the Better Auth default of 3600s / 1h — `expiresIn` left unset;
    `resetPasswordTokenExpiresIn` likewise defaults to 3600s).
  - `emailAndPassword`: add `requireEmailVerification: true`, `sendResetPassword`,
    `revokeSessionsOnPasswordReset: true` (keep `enabled: true`).
  - `advanced.backgroundTasks.handler` wired to the `AsyncLocalStorage`.
  - Export the exec-ctx store / a `runWithExecCtx(ctx, fn)` helper for the route.
- `src/index.ts` — wrap the `/api/auth/*` handler invocation in `runWithExecCtx`; add
  `AUTH_EMAIL` (binding), `AUTH_EMAIL_FROM`, `AUTH_EMAIL_FROM_NAME` to the `Env` type.
- `wrangler.jsonc` — add the `AUTH_EMAIL` `send_email` binding
  (`{ name: "AUTH_EMAIL", allowed_sender_addresses: ["noreply@releases.sh"] }`) and the
  `AUTH_EMAIL_*` vars to **both** the prod and `[env.staging]` blocks. _(Editable in
  code — not a secret/.env file.)_

**Web (`web/`)**

- `src/lib/auth-client.ts` — re-export `requestPasswordReset`, `resetPassword`,
  `sendVerificationEmail`.
- `src/components/auth-form.tsx` —
  - signup success → "Check your email" state (no redirect, since there's no session);
  - login 403 → "verify your email" + **Resend** affordance;
  - "Forgot password?" link (login mode).
- `src/app/forgot-password/page.tsx` _(new)_ — `AUTH_UI_ENABLED`-gated; email input →
  `requestPasswordReset`; enumeration-safe confirmation copy. Mirrors the login/signup
  page shell.
- `src/app/reset-password/page.tsx` _(new)_ — `AUTH_UI_ENABLED`-gated; reads `?token` /
  `?error`; new-password form → `resetPassword`; success → `/login` notice.
- `src/components/account-nav.tsx` — **no change**. Under the strict gate there is no
  signed-in-but-unverified state, so no "verify your email" nudge is needed in the nav.

## Config ownership

Items I cannot do (CF dashboard / secrets / Vercel are the user's):

- **Cloudflare:** enable **Email Sending** on the account (beta opt-in) and **verify the
  sending domain `releases.sh`** for Email Sending (DKIM). Until this is done, sends
  throw — but `sendAuthEmail` catches + logs, so nothing 500s; the link is still in logs.
- Prod enablement of the auth UI itself (`NEXT_PUBLIC_AUTH_UI_ENABLED`, etc.) remains a
  separate post-merge step from the handoff checklist — unchanged by this pass.

Items I wire in code: the `AUTH_EMAIL` binding + `AUTH_EMAIL_*` vars in `wrangler.jsonc`,
all server/web code above.

## Error handling / edge cases

- **Send failure** (domain unverified, beta hiccup, missing binding) → caught + logged;
  the auth response is unaffected; the link remains in Worker logs.
- **Invalid/expired token** → verify link redirects with `?error` to the callbackURL;
  reset link redirects to `redirectTo?error=INVALID_TOKEN`. Both pages render a clear
  "link expired — request a new one" path.
- **Absolute-URL discipline** — `callbackURL` (verify) and `redirectTo` (reset) are built
  with `new URL(safeRedirect(target), window.location.origin)`. Better Auth validates
  these against the existing `trustedOrigins` allow-list (releases.sh family + configured
  extras + loopback outside prod), so an off-origin redirect is rejected server-side.
- **Existing smoke-test users** created before this change have `emailVerified=0`; under
  the strict gate they can't sign in until verified. Acceptable (test data); no migration.

## Testing

- **Unit (`bun test`):**
  - `sendAuthEmail`: binding present → `send` called with the correct object shape;
    binding absent → logs the URL + returns `{ sent: false }`; `send` rejects → swallowed
    (no throw) + error logged.
  - `verifyEmailTemplate` / `resetPasswordTemplate`: subject set, the `url` appears in
    both `text` and `html`.
- **Live smoke (local `wrangler dev` with `AUTH_UI` on):**
  1. Sign up → form shows "Check your email"; grab the verify URL from Worker logs →
     open it → redirected back, signed in (session cookie on `.releases.localhost`).
  2. Sign out → "Forgot password?" → submit email → grab reset URL from logs → open →
     `/reset-password` with token → set new password → sign in with it.
- **Gates:** `npx tsc --noEmit` (root + `workers/api` + `web`), `bun run lint`,
  `bun run format:check`.

## Out of scope (follow-ups)

- **Auth-endpoint rate limiting** — the other prod blocker. Better Auth ships a built-in
  `rateLimit` with per-path `customRules` and `storage: "secondary-storage"` (KV); that's
  the likely lever, handled in its own task.
- Account linking (same email via Google + password), 2FA, passkeys.
- `onExistingUserSignUp` heads-up email to an existing user on a duplicate-signup attempt
  (cheap, nice-to-have).
- First authed product surface (relk\_ token management UI / account page) — separate.
