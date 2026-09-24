"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { authClient, useSession } from "@/lib/auth-client";
import { DEVICE_PURPOSE_COPY, devicePurpose } from "@/lib/device-purpose";
import type { DeviceAuthPurpose } from "@buildinternet/releases-core/api-token";
import {
  AccountPermission,
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
 *
 * The CLI names why it's asking (the device-code `scope`: `login`, `keys`,
 * `publish-tokens`), which only the claiming user can read back, so the page says
 * what's being approved. No purpose means a CLI that predates them.
 */
export function DeviceApproveForm() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;
  const searchParams = useSearchParams();
  const userCode = searchParams.get("user_code") ?? "";

  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [outcome, setOutcome] = useState<Outcome>("idle");
  const [error, setError] = useState<string | null>(null);
  // undefined while loading; null for a CLI that sends no purpose. A failed
  // lookup is its own state, never shown as an older CLI's request.
  const [purpose, setPurpose] = useState<DeviceAuthPurpose | null | undefined>(undefined);
  const [lookupFailed, setLookupFailed] = useState(false);

  useEffect(() => {
    if (!user || !userCode) return;
    let cancelled = false;
    setPurpose(undefined);
    setLookupFailed(false);
    const fail = () => {
      if (!cancelled) setLookupFailed(true);
    };
    authClient
      .device({ query: { user_code: userCode } })
      .then((res) => {
        if (res.error || !res.data) return fail();
        if (!cancelled) setPurpose(devicePurpose(res.data.scope));
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [user, userCode]);

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
        setError("That code is invalid or has expired. Run the command in your terminal again.");
        return;
      }
      setOutcome(kind === "approve" ? "approved" : "denied");
    } catch {
      setError("That code is invalid or has expired. Run the command in your terminal again.");
    } finally {
      setBusy(null);
    }
  }

  if (isPending || (user && userCode && purpose === undefined && !lookupFailed)) {
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
        {purpose === "login" || purpose == null
          ? "Device approved. Return to your terminal — the CLI will finish signing in automatically."
          : "Approved. Return to your terminal — the CLI will finish the command, then sign out."}
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
            disabled={busy !== null || lookupFailed}
            className={primaryButtonClass}
          >
            {busy === "approve" ? "Approving…" : "Approve device"}
          </button>
        </>
      }
    >
      {lookupFailed ? (
        <AuthError>
          Couldn&apos;t load this request, so it can&apos;t be approved here. Run the command in
          your terminal again.
        </AuthError>
      ) : (
        <ApprovalDetails purpose={purpose ?? null} userCode={userCode} email={user.email} />
      )}

      {error ? <AuthError>{error}</AuthError> : null}
    </AuthCard>
  );
}

/**
 * The card body for one device request: what's being approved, the code to
 * match, and the caution for that purpose. The purpose is a label the client
 * chose, not a limit: approval grants a full session, so the caution says so
 * and describes the purpose as what the real CLI does with it. `purpose` null is an older CLI that
 * sends none (it keeps its session after login, so the caution says so).
 */
export function ApprovalDetails({
  purpose,
  userCode,
  email,
}: {
  purpose: DeviceAuthPurpose | null;
  userCode: string;
  email: string;
}) {
  const copy = DEVICE_PURPOSE_COPY[purpose ?? "login"];
  return (
    <>
      <ConnVisual node="key" terminal />
      <CardTitle>{copy.title}</CardTitle>
      <IdentityRow>{email}</IdentityRow>

      <Divider />

      {userCode ? <DeviceCode value={userCode} /> : null}

      {copy.permission ? (
        <AccountPermission
          appName="the Releases CLI"
          title={copy.permission.title}
          desc={copy.permission.desc}
        />
      ) : (
        <ScopeGroups appName="the Releases CLI" scopes={["read"]} />
      )}

      <Caution>
        Only approve if you just ran <Code>{copy.command}</Code> yourself. The code above must match
        your terminal. Approving signs that device in to your account with full access.{" "}
        {purpose === "login" ? (
          <>
            The Releases CLI uses it to create a personal read-only <Code>relu_</Code> API key, then
            signs out.
          </>
        ) : purpose ? (
          <>The Releases CLI uses it for this one command, then signs out.</>
        ) : (
          <>
            The Releases CLI uses it to create a personal <Code>relu_</Code> API key. This version
            stays signed in afterwards; update it to sign out after each step.
          </>
        )}
      </Caution>

      <RevokeNote>
        {purpose === "publish-tokens" ? (
          <>
            Revoke publish tokens anytime from <Code>/account/webhooks</Code>.
          </>
        ) : (
          <>
            Revoke keys anytime from <Code>/account</Code>.
          </>
        )}
      </RevokeNote>
    </>
  );
}
