"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signIn, signUp, sendVerificationEmail } from "@/lib/auth-client";
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

export function AuthForm({ mode, redirectTo = "/" }: { mode: Mode; redirectTo?: string }) {
  const router = useRouter();
  const target = safeRedirect(redirectTo);
  const [pending, setPending] = useState(false);
  const [social, setSocial] = useState<"google" | "github" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  // After a sign-up, the user has NO session (verification is required) — show a
  // "check your email" panel instead of redirecting. On an unverified sign-in the
  // worker returns 403 and re-sends the link; show the same panel with a resend.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [phase, setPhase] = useState<"form" | "check-email">("form");
  const [resent, setResent] = useState(false);

  const busy = pending || social !== null;

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
      const result = await sendVerificationEmail({
        email: pendingEmail,
        callbackURL: callbackURL(),
      });
      // Better Auth surfaces request-level failures (rate-limit, bad request) in
      // `result.error` rather than throwing — only confirm resent on success.
      if (result.error) {
        setError(result.error.message ?? "Could not resend the email. Please try again.");
        return;
      }
      setResent(true);
    } catch {
      setError("Could not resend the email. Please try again.");
    } finally {
      setPending(false);
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
                <span className="font-medium text-stone-700 dark:text-stone-200">
                  {pendingEmail}
                </span>
                . Click it to finish signing in. {resent && "We just sent a fresh link."}
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
                  className="inline-flex h-10 items-center justify-center gap-2.5 border border-stone-300 bg-white px-4 text-sm font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900"
                >
                  {meta.icon}
                  {social === provider ? "Redirecting..." : `Continue with ${meta.label}`}
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
            autoComplete="email"
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
          className="inline-flex h-10 w-full items-center justify-center bg-stone-950 px-4 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-white"
        >
          {pending ? pendingLabel : submitLabel}
        </button>
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
