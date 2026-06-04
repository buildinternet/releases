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
