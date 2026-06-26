"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { authClient, useSession } from "@/lib/auth-client";
import {
  AuthCard,
  AuthError,
  CardTitle,
  Caution,
  Code,
  ConnVisual,
  DeviceCode,
  Divider,
  IdentityRow,
  outlineButtonClass,
  OutcomeCard,
  primaryButtonClass,
  RevokeNote,
  ScopeGroups,
} from "@/components/auth-flow";

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
      <AuthCard>
        <p className="py-2 text-center text-sm leading-6 text-stone-600 dark:text-stone-300">
          Please{" "}
          <Link
            href={`/login?redirect=${encodeURIComponent(ret)}`}
            className="font-medium text-[var(--accent)] underline underline-offset-2"
          >
            sign in
          </Link>{" "}
          to approve this device.
        </p>
      </AuthCard>
    );
  }

  if (outcome === "approved") {
    return (
      <OutcomeCard approved>
        Device approved. Return to your terminal — the CLI will finish signing in automatically.
      </OutcomeCard>
    );
  }

  if (outcome === "denied") {
    return (
      <OutcomeCard approved={false}>
        Request denied. No access was granted — you can close this page.
      </OutcomeCard>
    );
  }

  return (
    <AuthCard
      footer={
        <>
          <button
            type="button"
            onClick={() => act("deny")}
            disabled={busy !== null}
            className={outlineButtonClass}
          >
            {busy === "deny" ? "Denying…" : "Deny"}
          </button>
          <button
            type="button"
            onClick={() => act("approve")}
            disabled={busy !== null}
            className={primaryButtonClass}
          >
            {busy === "approve" ? "Approving…" : "Approve device"}
          </button>
        </>
      }
    >
      <ConnVisual node="key" terminal />
      <CardTitle>Approve the Releases CLI on this device</CardTitle>
      <IdentityRow>{user.email}</IdentityRow>

      <Divider />

      {userCode ? <DeviceCode value={userCode} /> : null}

      <ScopeGroups appName="the Releases CLI" scopes={["read"]} />

      <Caution>
        Only approve if you just ran <Code>releases login</Code> yourself. The code above must match
        your terminal. Approving issues a personal <Code>relu_</Code> API key.
      </Caution>

      {error ? <AuthError>{error}</AuthError> : null}

      <RevokeNote>
        Revoke this key anytime from <Code>/account</Code>.
      </RevokeNote>
    </AuthCard>
  );
}
