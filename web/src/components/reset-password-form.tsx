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
