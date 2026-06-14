"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  signIn,
  signUp,
  sendVerificationEmail,
  oneTap,
  getLastUsedLoginMethod,
} from "@/lib/auth-client";
import { safeRedirect } from "@/lib/auth-redirect";

type Mode = "login" | "signup";

/**
 * Social providers to surface as buttons, gated by `NEXT_PUBLIC_AUTH_SOCIAL_PROVIDERS`
 * (comma-separated, e.g. `google,github`). This is the CLIENT half of the same
 * "social-ready" seam the API worker uses: the server registers a provider only
 * when both halves of its credential pair resolve (`buildSocialProviders`), and
 * the web bundle — which can't read server secrets — reveals the button only when
 * this var lists it. Unset (the default) → email/password only, no broken buttons.
 * Flip both on together when the OAuth apps are wired.
 */
const SOCIAL_PROVIDERS = (process.env.NEXT_PUBLIC_AUTH_SOCIAL_PROVIDERS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s): s is "google" | "github" => s === "google" || s === "github");

/**
 * Whether to auto-prompt Google One Tap on mount. Requires BOTH the public One Tap
 * client id (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`, which is what registers the `oneTap`
 * action on the client — see `auth-client.ts`) AND Google being a surfaced social
 * provider, so One Tap and the "Continue with Google" fallback button stay in
 * lockstep. When off, the redirect-based button remains the only Google path.
 */
const GOOGLE_ONE_TAP_ENABLED =
  SOCIAL_PROVIDERS.includes("google") && Boolean(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID);

/**
 * Whether to surface the passwordless "Email me a sign-in link" button, gated by
 * `NEXT_PUBLIC_AUTH_MAGIC_LINK`. The CLIENT half of the magic-link seam: the worker
 * registers the magicLink plugin unconditionally (it needs only the AUTH_EMAIL
 * binding), and the `magicLinkClient` is always in the bundle, but the button stays
 * hidden until this flag is `"true"`. Lets the endpoints ship dark and the UI flip
 * on later (set in Vercel) without a code change. Unset → password/social only.
 */
const MAGIC_LINK_ENABLED = process.env.NEXT_PUBLIC_AUTH_MAGIC_LINK === "true";

/**
 * In local dev the API worker can't deliver real auth email — the AUTH_EMAIL
 * Cloudflare Email Sending binding only sends from a deployed env, and `wrangler dev`
 * simulates the send. So the normal "check your email" copy is a lie locally and
 * developers get stuck waiting for mail that never comes. Under `next dev`,
 * `NODE_ENV` is "development" (Next.js inlines it at build); a production build —
 * Vercel prod or any preview — sets it to "production", so this notice ships to zero
 * real users with no env var to remember. The worker logs the verify/sign-in link to
 * the `dev:api` console (see workers/api/src/auth/email.ts); this banner points there.
 */
const DEV_EMAIL_NOTICE = process.env.NODE_ENV === "development";

/**
 * Dev-only banner warning that auth emails aren't delivered locally and pointing to
 * the `dev:api` console for the link. `compact` trims the copy for the pre-submit
 * spot on the form (vs. the fuller version on the check-email panel). Renders nothing
 * outside local dev.
 */
function DevEmailNotice({ compact = false }: { compact?: boolean }) {
  if (!DEV_EMAIL_NOTICE) return null;
  return (
    <div className="border border-amber-300 bg-amber-50 px-3 py-2.5 text-[13px] leading-5 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em]">
        Dev mode
      </span>{" "}
      {compact
        ? "Auth emails aren't delivered locally — after submitting, copy the link from your dev:api console."
        : "No email is actually sent in local dev. Copy the verification / sign-in link from your dev:api console to continue."}
    </div>
  );
}

const PROVIDER_META: Record<"google" | "github", { label: string; icon: ReactNode }> = {
  google: {
    label: "Google",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[18px] w-[18px]">
        <path
          fill="#4285F4"
          d="M23.52 12.27c0-.82-.07-1.6-.21-2.36H12v4.46h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.72z"
        />
        <path
          fill="#34A853"
          d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.88-3c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.29v3.1A12 12 0 0 0 12 24z"
        />
        <path
          fill="#FBBC05"
          d="M5.29 14.29A7.2 7.2 0 0 1 4.91 12c0-.8.14-1.57.38-2.29v-3.1H1.29A12 12 0 0 0 0 12c0 1.94.46 3.77 1.29 5.39l4-3.1z"
        />
        <path
          fill="#EA4335"
          d="M12 4.76c1.76 0 3.34.61 4.58 1.8l3.43-3.43C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.29 6.61l4 3.1C6.23 6.87 8.88 4.76 12 4.76z"
        />
      </svg>
    ),
  },
  github: {
    label: "GitHub",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[18px] w-[18px] fill-current">
        <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1-.02-1.96-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.05 11.05 0 0 1 5.78 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.68.8.56C20.71 21.39 24 17.08 24 12 24 5.73 18.77.5 12 .5Z" />
      </svg>
    ),
  },
};

/** Map a Better Auth client error to friendly copy, falling back to its message. */
function prettyError(error: { message?: string } | null, mode: Mode): string {
  const msg = error?.message?.trim();
  if (msg) return msg;
  return mode === "signup"
    ? "Could not create your account. Please try again."
    : "Could not sign you in. Please try again.";
}

const inputClass =
  "mt-2 w-full border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-2.5 text-sm text-stone-900 dark:text-stone-100 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20";
const labelClass =
  "block text-[11px] font-medium uppercase tracking-[0.18em] text-stone-500 dark:text-stone-400";

/**
 * Small pill marking the method the returning user last signed in with. Uses
 * `currentColor` for both border and text (via the button's inherited text color)
 * plus a flat opacity so it reads on every button variant — the dark-bg outline
 * buttons (Google, magic-link) AND the inverted light-bg primary "Sign in" button
 * — without per-button color overrides. Absolutely positioned so it doesn't push
 * the button's centered label.
 */
function LastUsedBadge() {
  return (
    <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full border border-current px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider opacity-55">
      Last used
    </span>
  );
}

export function AuthForm({ mode, redirectTo = "/" }: { mode: Mode; redirectTo?: string }) {
  const router = useRouter();
  const target = safeRedirect(redirectTo);
  const [pending, setPending] = useState(false);
  const [social, setSocial] = useState<"google" | "github" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  // The method the user last signed in with ("google" | "email" | "magic-link"),
  // read client-side from the non-httpOnly cookie the last-login-method plugin
  // sets. Read in an effect rather than during render because it touches
  // document.cookie — reading inline would diverge between SSR (null) and the
  // client and trip hydration. Login surface only: a "last used" hint is
  // meaningless on the signup form (no prior method for a new account).
  const [lastMethod, setLastMethod] = useState<string | null>(null);
  useEffect(() => {
    if (mode === "login") setLastMethod(getLastUsedLoginMethod());
  }, [mode]);

  // After a sign-up, the user has NO session (verification is required) — show a
  // "check your email" panel instead of redirecting. On an unverified sign-in the
  // worker returns 403 and re-sends the link; show the same panel with a resend.
  // The same panel serves the magic-link flow; `checkEmailKind` keys the copy and
  // which email the resend re-sends (verification vs. a fresh sign-in link).
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [phase, setPhase] = useState<"form" | "check-email">("form");
  const [resent, setResent] = useState(false);
  const [checkEmailKind, setCheckEmailKind] = useState<"verify" | "magic-link">("verify");
  // Dedicated pending flag for the magic-link send so its button shows "Sending..."
  // without coupling to the password submit's `pending`.
  const [magicSending, setMagicSending] = useState(false);
  // Dedicated pending flag for the explicit "Sign in with a passkey" button.
  const [passkeyPending, setPasskeyPending] = useState(false);

  const busy = pending || social !== null || magicSending || passkeyPending;

  // Auto-prompt Google One Tap on mount (login + signup surfaces). On success,
  // soft-navigate to the post-auth target like the email/social flows do, rather
  // than One Tap's default hard redirect to "/". If the user dismisses the prompt
  // or Google can't render it, the "Continue with Google" button below is the
  // manual fallback — `onPromptNotification` intentionally adds no extra UI. Any
  // GSI error (blocked third-party context, no Google session) is non-fatal.
  useEffect(() => {
    if (!GOOGLE_ONE_TAP_ENABLED || typeof oneTap !== "function") return;
    void oneTap({
      fetchOptions: {
        onSuccess: () => {
          router.push(target);
          router.refresh();
        },
      },
      onPromptNotification: () => {},
    }).catch(() => {});
  }, [router, target]);

  // Passkey conditional UI (autofill). On the login surface, if the browser
  // supports conditional mediation, open a non-modal passkey request so the email
  // field's autofill dropdown can offer a saved passkey. Selecting one signs the
  // user in and we soft-navigate like the other flows; if the browser lacks support
  // or the user ignores it, the explicit "Sign in with a passkey" button below is
  // the fallback. All failure modes (no support, user dismissal, no passkey) are
  // non-fatal — the request just never resolves, so we swallow errors. `cancelled`
  // guards against a post-unmount navigation.
  useEffect(() => {
    if (mode !== "login") return;
    const PKC = typeof window !== "undefined" ? window.PublicKeyCredential : undefined;
    if (!PKC || typeof PKC.isConditionalMediationAvailable !== "function") return;
    let cancelled = false;
    void (async () => {
      try {
        if (!(await PKC.isConditionalMediationAvailable()) || cancelled) return;
        const res = await signIn.passkey({ autoFill: true });
        if (cancelled || !res || res.error) return;
        router.push(target);
        router.refresh();
      } catch {
        // No support / user dismissal / no passkey — all non-fatal.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, router, target]);

  // Absolute callback URL on THIS web origin — the verify link redirects here
  // after the worker verifies + auto-signs-in (a relative URL would resolve
  // against the worker's baseURL and strand the user on api.releases.sh).
  function callbackURL(): string {
    return new URL(target, window.location.origin).toString();
  }

  // Explicit passkey sign-in (the button below). Opens the modal WebAuthn prompt;
  // on success soft-navigate to the post-auth target. The register/sign-in passkey
  // responses always resolve with a data object carrying `error` (per the plugin
  // docs — `throw: true` has no effect), so we check `error` rather than catch; the
  // catch covers a user-cancelled or unsupported ceremony that rejects.
  async function onPasskey() {
    if (busy) return;
    setError(null);
    setPasskeyPending(true);
    try {
      const result = await signIn.passkey();
      if (result?.error) {
        setError(result.error.message ?? "Could not sign in with a passkey. Please try again.");
        return;
      }
      router.push(target);
      router.refresh();
    } catch {
      setError("Passkey sign-in was cancelled or isn't available on this device.");
    } finally {
      setPasskeyPending(false);
    }
  }

  async function resend() {
    if (!pendingEmail || busy) return;
    setError(null);
    // Same shape for both panels — only the API call, the loading flag, and the copy
    // differ. Magic-link re-issues a fresh sign-in link (a new token; the email-only
    // resend means a brand-new account would land `name: ""`, same as the server's
    // default — name only matters on first creation and isn't re-collected here);
    // verify re-sends the verification link. Better Auth surfaces request-level
    // failures (rate-limit, bad request) in `result.error` rather than throwing, so
    // we only confirm `resent` on success.
    const isMagic = checkEmailKind === "magic-link";
    const setSending = isMagic ? setMagicSending : setPending;
    const failMsg = isMagic
      ? "Could not resend the link. Please try again."
      : "Could not resend the email. Please try again.";
    setSending(true);
    try {
      const result = isMagic
        ? await signIn.magicLink({ email: pendingEmail, callbackURL: callbackURL() })
        : await sendVerificationEmail({ email: pendingEmail, callbackURL: callbackURL() });
      if (result.error) {
        setError(result.error.message ?? failMsg);
        return;
      }
      setResent(true);
    } catch {
      setError(failMsg);
    } finally {
      setSending(false);
    }
  }

  // Passwordless sign-in: email the user a one-time link. Reads the email (and, in
  // signup mode, the optional name) straight from the form — the button is
  // `type="button"`, so HTML5 required/minLength on the password field don't block
  // it. On success, reuse the "check your email" panel (kind = magic-link). A
  // brand-new email auto-creates a verified account on click (server `disableSignUp`
  // is off); `name` is forwarded only when present so first-time signups carry it.
  async function onMagicLink(event: React.MouseEvent<HTMLButtonElement>) {
    if (busy) return;
    const form = event.currentTarget.form;
    if (!form) return;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const name = String(data.get("name") ?? "").trim();
    if (!email) {
      setError("Enter your email to get a sign-in link.");
      return;
    }
    setError(null);
    setMagicSending(true);
    try {
      const result = await signIn.magicLink({
        email,
        ...(mode === "signup" && name ? { name } : {}),
        callbackURL: callbackURL(),
      });
      if (result.error) {
        setError(result.error.message ?? "Could not send a sign-in link. Please try again.");
        return;
      }
      setPendingEmail(email);
      setCheckEmailKind("magic-link");
      setResent(false);
      setPhase("check-email");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setMagicSending(false);
    }
  }

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

  async function onSocial(provider: "google" | "github") {
    if (busy) return;
    setError(null);
    setSocial(provider);
    try {
      // On success this triggers a full-page redirect to the provider; an error
      // means the provider isn't configured server-side (or the call failed). The
      // callback must be ABSOLUTE on the web origin (see `callbackURL` above) — a
      // relative one resolves against the worker's baseURL and would strand the
      // user on api.releases.sh after the OAuth round-trip.
      const result = await signIn.social({ provider, callbackURL: callbackURL() });
      if (result.error) {
        setError(prettyError(result.error, mode));
        setSocial(null);
      }
    } catch {
      setError(`Could not start ${PROVIDER_META[provider].label} sign-in. Please try again.`);
      setSocial(null);
    }
  }

  const submitLabel = mode === "signup" ? "Create account" : "Sign in";
  const pendingLabel = mode === "signup" ? "Creating account..." : "Signing in...";

  if (phase === "check-email") {
    const isMagic = checkEmailKind === "magic-link";
    const linkNoun = isMagic ? "sign-in link" : "verification link";
    const heading = isMagic ? "Your sign-in link is on its way" : "Verify your email address";
    const action = isMagic ? "Click it to sign in." : "Click it to finish signing in.";
    const resendLabel = isMagic ? "Resend sign-in link" : "Resend verification email";
    const resendBusy = isMagic ? magicSending : pending;
    return (
      <div className="space-y-5">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
            Check your email
          </p>
          <h2 className="mt-3 text-lg font-semibold tracking-tight text-stone-900 dark:text-stone-100">
            {heading}
          </h2>
          <p className="mt-3 text-sm leading-6 text-stone-500 dark:text-stone-400">
            {pendingEmail ? (
              <>
                We sent a {linkNoun} to{" "}
                <span className="font-medium text-stone-700 dark:text-stone-200">
                  {pendingEmail}
                </span>
                . {action} {resent && "We just sent a fresh link."}
              </>
            ) : (
              `We sent you a ${linkNoun}. ${action}`
            )}
          </p>
        </div>
        <DevEmailNotice />
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
          {resendBusy ? "Sending..." : resendLabel}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {SOCIAL_PROVIDERS.length > 0 && (
        <>
          <div className="grid gap-3">
            {SOCIAL_PROVIDERS.map((provider) => {
              const meta = PROVIDER_META[provider];
              return (
                <button
                  key={provider}
                  type="button"
                  onClick={() => onSocial(provider)}
                  disabled={busy}
                  className="relative inline-flex h-10 items-center justify-center gap-2.5 border border-stone-300 bg-white px-4 text-sm font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900"
                >
                  {meta.icon}
                  {social === provider ? "Redirecting..." : `Continue with ${meta.label}`}
                  {lastMethod === provider && <LastUsedBadge />}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-stone-200 dark:bg-stone-800" />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
              or
            </span>
            <span className="h-px flex-1 bg-stone-200 dark:bg-stone-800" />
          </div>
        </>
      )}

      <form onSubmit={onSubmit} className="space-y-5" noValidate={false}>
        {mode === "signup" && (
          <div>
            <label htmlFor="name" className={labelClass}>
              Name <span className="text-blue-500">*</span>
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              autoComplete="name"
              placeholder="Ada Lovelace"
              className={inputClass}
            />
          </div>
        )}

        <div>
          <label htmlFor="email" className={labelClass}>
            Email <span className="text-blue-500">*</span>
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            // `webauthn` (last token) opts the email field into passkey conditional
            // UI on the login surface — see the autofill effect above. Login-only so
            // the signup field stays a plain email input.
            autoComplete={mode === "login" ? "email webauthn" : "email"}
            placeholder="you@example.com"
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="password" className={labelClass}>
            Password <span className="text-blue-500">*</span>
          </label>
          <div className="relative">
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              required
              minLength={8}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
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

        {/* -mt-2 tucks this under the password field, offsetting the form's space-y-5 gap */}
        {mode === "login" && (
          <p className="-mt-2 text-right text-sm">
            <Link
              href="/forgot-password"
              className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
            >
              Forgot password?
            </Link>
          </p>
        )}

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="relative inline-flex h-10 w-full items-center justify-center bg-stone-950 px-4 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-white"
        >
          {pending ? pendingLabel : submitLabel}
          {lastMethod === "email" && <LastUsedBadge />}
        </button>

        {/* Passkey sign-in (login only). `type="button"` so it doesn't trip the
            password field's required/minLength validation. Always shown — the
            passkey plugin is always registered server-side; the modal prompt simply
            reports "no passkey" if the user has none. */}
        {mode === "login" && (
          <button
            type="button"
            onClick={onPasskey}
            disabled={busy}
            className="relative inline-flex h-10 w-full items-center justify-center border border-stone-300 bg-white px-4 text-sm font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900"
          >
            {passkeyPending ? "Waiting for your device…" : "Sign in with a passkey"}
            {lastMethod === "passkey" && <LastUsedBadge />}
          </button>
        )}

        {/* Passwordless alternative. `type="button"` so it reads the email from the
            form without tripping the password field's required/minLength validation. */}
        {MAGIC_LINK_ENABLED && (
          <button
            type="button"
            onClick={onMagicLink}
            disabled={busy}
            className="relative inline-flex h-10 w-full items-center justify-center border border-stone-300 bg-white px-4 text-sm font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900"
          >
            {magicSending ? "Sending link..." : "Email me a sign-in link"}
            {lastMethod === "magic-link" && <LastUsedBadge />}
          </button>
        )}
      </form>

      <p className="text-sm text-stone-500 dark:text-stone-400">
        {mode === "signup" ? (
          <>
            Already have an account?{" "}
            <Link
              href={target === "/" ? "/login" : `/login?redirect=${encodeURIComponent(target)}`}
              className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
            >
              Sign in
            </Link>
          </>
        ) : (
          <>
            New to releases.sh?{" "}
            <Link
              href={target === "/" ? "/signup" : `/signup?redirect=${encodeURIComponent(target)}`}
              className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
            >
              Create an account
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
