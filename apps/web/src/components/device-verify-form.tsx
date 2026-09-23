"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient, useSession } from "@/lib/auth-client";
import {
  AuthCard,
  AuthError,
  CardTitle,
  Code,
  ConnVisual,
  Divider,
  primaryButtonClass,
} from "@/components/auth-flow";

const inputClass =
  "mt-2 w-full rounded-[11px] border border-stone-200 bg-stone-50 px-3 py-3 text-center font-mono text-[18px] uppercase tracking-[0.26em] text-stone-900 outline-none transition focus:border-[var(--accent)] dark:border-stone-700 dark:bg-stone-950/60 dark:text-stone-100";

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
    <form onSubmit={onSubmit} className="w-full max-w-[460px]">
      <AuthCard
        footer={
          <button type="submit" disabled={submitting} className={primaryButtonClass}>
            {submitting ? "Checking…" : "Continue"}
          </button>
        }
      >
        <ConnVisual node="key" terminal />
        <CardTitle>Connect the Releases CLI</CardTitle>

        <Divider />

        <label
          htmlFor="user-code"
          className="block text-[13px] font-medium text-stone-700 dark:text-stone-200"
        >
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
        <p className="mt-2 text-[12.5px] leading-[1.5] text-stone-500 dark:text-stone-400">
          Enter the code shown in your terminal after running <Code>releases login</Code>.
        </p>

        {error ? <AuthError>{error}</AuthError> : null}

        {!user ? (
          <p className="mt-3 text-[12.5px] leading-[1.5] text-stone-400 dark:text-stone-500">
            You&apos;ll be asked to sign in first, then returned here to approve the device.
          </p>
        ) : null}
      </AuthCard>
    </form>
  );
}
