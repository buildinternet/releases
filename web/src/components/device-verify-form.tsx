"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient, useSession } from "@/lib/auth-client";

const labelClass = "block text-sm font-medium text-stone-700 dark:text-stone-200";
const inputClass =
  "mt-1 w-full border border-stone-300 bg-white px-3 py-2 font-mono text-base uppercase tracking-[0.3em] text-stone-900 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100";
const buttonClass =
  "inline-flex h-10 items-center justify-center border border-stone-300 bg-white px-4 text-sm font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900";

/** Normalize a typed/pasted user code: drop dashes + spaces, uppercase. */
function normalizeUserCode(raw: string): string {
  return raw.trim().replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Step 1 of the device flow's browser half: the user enters (or arrives with) the
 * user code shown by `releases login`. Verifying via `GET /device` CLAIMS the
 * pending code for THIS signed-in session — only the same session can then approve
 * it on the next page. So if the user isn't signed in we bounce through /login with
 * a return URL that re-enters this page with the code preserved.
 */
export function DeviceVerifyForm() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;
  const router = useRouter();
  const searchParams = useSearchParams();

  const [userCode, setUserCode] = useState(searchParams.get("user_code") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    const code = normalizeUserCode(userCode);
    if (!code) {
      setError("Enter the code shown in your terminal.");
      return;
    }

    // Not signed in → claim the code under a real session. Return here afterward
    // with the code preserved (the approve step requires the SAME session).
    if (!user) {
      const ret = `/device?user_code=${encodeURIComponent(code)}`;
      router.push(`/login?redirect=${encodeURIComponent(ret)}`);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await authClient.device({ query: { user_code: code } });
      if (res.error) {
        setError("That code is invalid or has expired. Check your terminal and try again.");
        return;
      }
      router.push(`/device/approve?user_code=${encodeURIComponent(code)}`);
    } catch {
      setError("That code is invalid or has expired. Check your terminal and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (isPending) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div>
        <label htmlFor="user-code" className={labelClass}>
          Device code
        </label>
        <input
          id="user-code"
          value={userCode}
          onChange={(e) => setUserCode(e.target.value)}
          placeholder="XXXX-XXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
          className={inputClass}
          required
        />
        <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">
          Enter the code shown in your terminal after running{" "}
          <code className="font-mono text-[0.85em] text-stone-600 dark:text-stone-300">
            releases login
          </code>
          .
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {!user && (
        <p className="text-sm leading-6 text-stone-500 dark:text-stone-400">
          You'll{" "}
          <Link href="/login?redirect=/device" className="underline">
            sign in
          </Link>{" "}
          first, then return here to approve the device.
        </p>
      )}

      <button type="submit" disabled={submitting} className={buttonClass}>
        {submitting ? "Checking…" : "Continue"}
      </button>
    </form>
  );
}
