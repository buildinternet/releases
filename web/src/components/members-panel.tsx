"use client";

import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { useWorkspaces } from "@/components/account/use-workspaces";
import { PanelGrid } from "@/components/account/settings-section";
import { Aside } from "@/components/account/ui";
import { WorkspaceDetailPanel } from "@/components/workspace-detail-panel";

/**
 * Workspace "Members" — the active workspace's members + invitations, backed by
 * the real org plugin via {@link WorkspaceDetailPanel} (shipped in #1741). The
 * sidebar selector / account dropdown choose which workspace is active.
 */
const ROLES = [
  { name: "Owner", desc: "Full control, including billing and deletion." },
  { name: "Admin", desc: "Manage members, sources, and settings." },
  { name: "Member", desc: "View and curate releases." },
];

export function MembersPanel() {
  const { data, isPending } = useSession();
  const user = data?.user;
  const { active, workspaces } = useWorkspaces();
  const current = active ?? workspaces[0] ?? null;

  if (isPending) return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;

  if (!user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account/members" className="underline">
          sign in
        </Link>{" "}
        to manage members.
      </p>
    );
  }

  return (
    <PanelGrid
      aside={
        <Aside label="Roles">
          <div className="flex flex-col gap-3">
            {ROLES.map((r) => (
              <div key={r.name}>
                <div className="text-[13px] font-semibold text-stone-900 dark:text-stone-100">
                  {r.name}
                </div>
                <div className="text-[12.5px] leading-snug text-stone-600 dark:text-stone-300">
                  {r.desc}
                </div>
              </div>
            ))}
          </div>
        </Aside>
      }
    >
      {current ? (
        <WorkspaceDetailPanel workspaceId={current.id} />
      ) : (
        <p className="rounded-xl border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
          You don't have a workspace yet. Create one from the switcher in the sidebar.
        </p>
      )}
    </PanelGrid>
  );
}
