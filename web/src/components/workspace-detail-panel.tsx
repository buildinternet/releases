// web/src/components/workspace-detail-panel.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession, organization } from "@/lib/auth-client";
import { isManager } from "@/lib/workspace-permissions";
import { WorkspaceMembers, type WorkspaceMemberRow } from "./workspace-members";
import { WorkspaceInvitations, type WorkspaceInvitationRow } from "./workspace-invitations";

type FullOrg = {
  id: string;
  name: string;
  slug: string;
  members: WorkspaceMemberRow[];
  invitations: WorkspaceInvitationRow[];
};

export function WorkspaceDetailPanel({ organizationId }: { organizationId: string }) {
  const { data: session, isPending } = useSession();
  const [org, setOrg] = useState<FullOrg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await organization.getFullOrganization({ query: { organizationId } });
      if (res.error) {
        setError(res.error.message ?? "Could not load this workspace.");
        setOrg(null);
      } else {
        setOrg(res.data as FullOrg);
      }
    } catch {
      setError("Could not load this workspace.");
      setOrg(null);
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    if (isPending) return;
    if (!session?.user) {
      setLoading(false);
      return;
    }
    void load();
  }, [isPending, session, load]);

  if (isPending || loading) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (!session?.user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href={`/login?redirect=/account/workspaces/${organizationId}`} className="underline">
          sign in
        </Link>{" "}
        to manage this workspace.
      </p>
    );
  }

  if (error || !org) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error ?? "Workspace not found."}
        </p>
        <Link
          href="/account/workspaces"
          className="text-sm text-stone-500 underline dark:text-stone-400"
        >
          Back to workspaces
        </Link>
      </div>
    );
  }

  const viewerUserId = session.user.id;
  const viewerRole = org.members.find((m) => m.userId === viewerUserId)?.role ?? null;
  const pendingInvitations = org.invitations.filter((i) => i.status === "pending");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-base font-medium text-stone-900 dark:text-stone-100">
            {org.name}
          </p>
          <p className="mt-0.5 font-mono text-xs text-stone-500 dark:text-stone-400">{org.slug}</p>
        </div>
        <Link
          href="/account/workspaces"
          className="shrink-0 text-sm text-stone-500 underline dark:text-stone-400"
        >
          All workspaces
        </Link>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Members</h2>
        <WorkspaceMembers
          organizationId={org.id}
          members={org.members}
          viewerRole={viewerRole}
          viewerUserId={viewerUserId}
          onChanged={load}
        />
      </section>

      {isManager(viewerRole) && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Invitations</h2>
          <WorkspaceInvitations
            organizationId={org.id}
            invitations={pendingInvitations}
            onChanged={load}
          />
        </section>
      )}
    </div>
  );
}
