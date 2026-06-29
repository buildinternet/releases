"use client";

import { useState } from "react";
import Link from "next/link";
import { requestPasswordReset } from "@/lib/auth-client";
import { AuthCard, AuthError, AuthHeading, primaryButtonClass } from "@/components/auth-flow";

const inputClass =
  "mt-2 w-full rounded-[11px] border border-stone-200 bg-white px-3.5 py-2.5 text-[14px] text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-[var(--accent)] dark:border-stone-700 dark:bg-stone-950/60 dark:text-stone-100 dark:placeholder:text-stone-500";
const labelClass = "block text-[12.5px] font-medium text-stone-700 dark:text-stone-200";

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
      const result = await requestPasswordReset({ email, redirectTo });
      // Enumeration-safe: the server returns success for unknown emails, so
      // result.error only fires on genuine failures (rate-limit, server error) —
      // surface those rather than show a false "sent" confirmation.
      if (result.error) {
        setError(result.error.message ?? "Could not send reset link. Please try again.");
        return;
      }
      setSent(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <AuthCard>
        <AuthHeading
          title="Check your email"
          subtitle="If an account exists for that email, we've sent a password reset link. Check your inbox."
        />
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthHeading
        title="Reset your password"
        subtitle="Enter your email and we'll send you a link to set a new password."
      />
      <form onSubmit={onSubmit} className="space-y-5">
        <div>
          <label htmlFor="email" className={labelClass}>
            Email <span className="text-[var(--accent)]">*</span>
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
        {error && <AuthError>{error}</AuthError>}
        <button type="submit" disabled={pending} className={`${primaryButtonClass} w-full`}>
          {pending ? "Sending..." : "Send reset link"}
        </button>
      </form>

      <p className="mt-6 text-center text-[13px] text-stone-500 dark:text-stone-400">
        Remembered it?{" "}
        <Link
          href="/login"
          className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
