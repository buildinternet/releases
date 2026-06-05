"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { authClient, useSession } from "@/lib/auth-client";

const buttonClass =
  "inline-flex h-10 items-center justify-center border px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60";
const approveClass = `${buttonClass} border-green-600/40 bg-green-50 text-green-800 hover:bg-green-100 dark:border-green-500/40 dark:bg-green-950/40 dark:text-green-300 dark:hover:bg-green-950/60`;
const denyClass = `${buttonClass} border-stone-300 bg-white text-stone-800 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900`;

type Outcome = "idle" | "approved" | "denied";

/**
 * Step 2 of the device flow's browser half: the signed-in user who claimed the code
 * on /device approves or denies the pending request. Better Auth binds approval to
 * the claiming session, so we require a session here too — if it's missing we bounce
 * back through /login → /device (re-claim) rather than approve under the wrong user.
 */
export function DeviceApproveForm() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;
  const searchParams = useSearchParams();
  const userCode = searchParams.get("user_code") ?? "";

  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [outcome, setOutcome] = useState<Outcome>("idle");
  const [error, setError] = useState<string | null>(null);

  async function act(kind: "approve" | "deny") {
    if (busy) return;
    if (!userCode) {
      setError("Missing device code. Re-open the link from your terminal.");
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      const res =
        kind === "approve"
          ? await authClient.device.approve({ userCode })
          : await authClient.device.deny({ userCode });
      if (res.error) {
        setError("That code is invalid or has expired. Run `releases login` again.");
        return;
      }
      setOutcome(kind === "approve" ? "approved" : "denied");
    } catch {
      setError("That code is invalid or has expired. Run `releases login` again.");
    } finally {
      setBusy(null);
    }
  }

  if (isPending) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  // No session → the approval would bind to the wrong (no) user. Send them to sign
  // in and re-claim the code on /device.
  if (!user) {
    const ret = `/device?user_code=${encodeURIComponent(userCode)}`;
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href={`/login?redirect=${encodeURIComponent(ret)}`} className="underline">
          sign in
        </Link>{" "}
        to approve this device.
      </p>
    );
  }

  if (outcome === "approved") {
    return (
      <div
        role="status"
        className="border border-green-600/30 bg-green-50 p-4 text-sm leading-6 text-green-800 dark:border-green-500/30 dark:bg-green-950/40 dark:text-green-300"
      >
        Device approved. Return to your terminal — the CLI will finish signing in automatically.
      </div>
    );
  }

  if (outcome === "denied") {
    return (
      <div
        role="status"
        className="border border-stone-300 bg-stone-50 p-4 text-sm leading-6 text-stone-700 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-300"
      >
        Request denied. No access was granted. You can close this page.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        A device is requesting access to your{" "}
        <span className="font-medium text-stone-900 dark:text-stone-100">{user.email}</span>{" "}
        account. Approve only if you just started{" "}
        <code className="font-mono text-[0.85em] text-stone-600 dark:text-stone-300">
          releases login
        </code>{" "}
        yourself.
      </p>

      {userCode && (
        <p className="font-mono text-sm text-stone-500 dark:text-stone-400">
          Code:{" "}
          <span className="tracking-[0.3em] text-stone-900 dark:text-stone-100">{userCode}</span>
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => act("approve")}
          disabled={busy !== null}
          className={approveClass}
        >
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
        <button
          type="button"
          onClick={() => act("deny")}
          disabled={busy !== null}
          className={denyClass}
        >
          {busy === "deny" ? "Denying…" : "Deny"}
        </button>
      </div>
    </div>
  );
}
