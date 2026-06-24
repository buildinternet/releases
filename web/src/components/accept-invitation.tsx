"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession, organization, signOut } from "@/lib/auth-client";
import {
  deriveAcceptState,
  type GetInvitationData,
  type InvitationFetchError,
} from "@/lib/invitation-state";

const buttonClass =
  "inline-flex h-9 items-center justify-center gap-2 border border-stone-300 bg-white px-3 text-sm font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900";
const primaryButtonClass =
  "inline-flex h-9 items-center justify-center gap-2 border border-stone-900 bg-stone-900 px-4 text-sm font-medium text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200";

export function AcceptInvitation({ invitationId }: { invitationId: string }) {
  const { data: session, isPending } = useSession();
  const sessionEmail = isPending ? undefined : (session?.user?.email ?? null);

  const [invitation, setInvitation] = useState<GetInvitationData | null>(null);
  const [fetchError, setFetchError] = useState<InvitationFetchError | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  const router = useRouter();

  // getInvitation requires a session; only fetch once signed in.
  useEffect(() => {
    if (!sessionEmail) return;
    let cancelled = false;
    setInvitation(null);
    setFetchError(null);
    organization
      .getInvitation({ query: { id: invitationId } })
      .then((res) => {
        if (cancelled) return;
        if (res.error) {
          setFetchError({
            status: res.error.status,
            code: res.error.code,
            message: res.error.message,
          });
        } else {
          setInvitation(res.data as GetInvitationData);
        }
      })
      .catch(() => {
        if (!cancelled) setFetchError({ message: "Could not load the invitation." });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionEmail, invitationId]);

  const onAccept = useCallback(async () => {
    if (busy || !invitation) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await organization.acceptInvitation({ invitationId });
      if (res.error) {
        setActionError(res.error.message ?? "Could not accept the invitation.");
        return;
      }
      const orgId = invitation.organizationId;
      await organization.setActive({ organizationId: orgId });
      router.push(`/account/workspaces/${orgId}`);
    } catch {
      setActionError("Could not accept the invitation.");
    } finally {
      setBusy(false);
    }
  }, [busy, invitation, invitationId, router]);

  const onDecline = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await organization.rejectInvitation({ invitationId });
      if (res.error) {
        setActionError(res.error.message ?? "Could not decline the invitation.");
        return;
      }
      setDeclined(true);
    } catch {
      setActionError("Could not decline the invitation.");
    } finally {
      setBusy(false);
    }
  }, [busy, invitationId]);

  if (declined) {
    return (
      <Shell title="Invitation declined">
        <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
          You have declined this invitation.
        </p>
        <HomeLink />
      </Shell>
    );
  }

  const state = deriveAcceptState({ invitationId, sessionEmail, invitation, error: fetchError });

  switch (state.kind) {
    case "loading":
      return (
        <Shell title="Invitation">
          <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>
        </Shell>
      );
    case "signed-out":
      return (
        <Shell title="Accept your invitation">
          <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
            Sign in to view and accept your workspace invitation.
          </p>
          <Link
            href={`/login?redirect=/accept-invitation/${invitationId}`}
            className={primaryButtonClass}
          >
            Sign in
          </Link>
        </Shell>
      );
    case "email-mismatch":
      return (
        <Shell title="Wrong account">
          <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
            This invitation was sent to a different email address than the one you are signed in
            with ({state.sessionEmail}). Sign out and sign in with the invited address to accept it.
          </p>
          <button type="button" className={buttonClass} onClick={() => void signOut()}>
            Sign out
          </button>
        </Shell>
      );
    case "invalid":
      return (
        <Shell title="Invitation unavailable">
          <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
            This invitation is no longer valid or has already been used.
          </p>
          <HomeLink />
        </Shell>
      );
    case "error":
      return (
        <Shell title="Something went wrong">
          <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">{state.message}</p>
          <HomeLink />
        </Shell>
      );
    case "ready":
      return (
        <Shell title={`Join ${state.organizationName}`}>
          <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
            {state.inviterEmail} invited you to join the{" "}
            <span className="font-medium text-stone-900 dark:text-stone-100">
              {state.organizationName}
            </span>{" "}
            workspace.
          </p>
          {actionError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {actionError}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void onAccept()}
              className={primaryButtonClass}
            >
              {busy ? "Joining…" : "Accept"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void onDecline()}
              className={buttonClass}
            >
              Decline
            </button>
          </div>
        </Shell>
      );
  }
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
        {title}
      </h1>
      {children}
    </div>
  );
}

function HomeLink() {
  return (
    <Link
      href="/account/workspaces"
      className="text-sm text-stone-500 underline dark:text-stone-400"
    >
      Go to your workspaces
    </Link>
  );
}
