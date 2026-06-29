"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { resetPassword } from "@/lib/auth-client";
import { AuthCard, AuthError, AuthHeading, primaryButtonClass } from "@/components/auth-flow";

const inputClass =
  "mt-2 w-full rounded-[11px] border border-stone-200 bg-white px-3.5 py-2.5 text-[14px] text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-[var(--accent)] dark:border-stone-700 dark:bg-stone-950/60 dark:text-stone-100 dark:placeholder:text-stone-500";
const labelClass = "block text-[12.5px] font-medium text-stone-700 dark:text-stone-200";

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
    <AuthCard>
      <AuthHeading
        title="Set a new password"
        subtitle="Choose a new password for your releases.sh account."
      />
      <form onSubmit={onSubmit} className="space-y-5">
        <div>
          <label htmlFor="password" className={labelClass}>
            New password <span className="text-[var(--accent)]">*</span>
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
        {error && <AuthError>{error}</AuthError>}
        <button type="submit" disabled={pending} className={`${primaryButtonClass} w-full`}>
          {pending ? "Resetting..." : "Reset password"}
        </button>
      </form>
    </AuthCard>
  );
}
