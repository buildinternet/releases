"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { UserWebhookListItem } from "@buildinternet/releases-api-types";
import { useSession } from "@/lib/auth-client";
import { useWorkspaces } from "@/components/account/use-workspaces";
import { WebhooksPanel, type WebhooksPanelClient } from "@/components/webhooks-panel";
import {
  createWorkspaceWebhook,
  deleteWorkspaceWebhook,
  listWorkspaceWebhookDeliveries,
  listWorkspaceWebhooks,
  rotateWorkspaceWebhookSecret,
  testWorkspaceWebhook,
  updateWorkspaceWebhook,
} from "@/lib/webhooks";
import { parseWebhookCreatePrefill } from "@/lib/webhook-create";

/** Binds the workspace-scoped webhook CRUD calls to one workspace id. */
function makeWorkspaceClient(workspaceId: string): WebhooksPanelClient {
  return {
    list: async () => (await listWorkspaceWebhooks(workspaceId)).subscriptions,
    create: (input) => createWorkspaceWebhook(workspaceId, input),
    update: (id, patch) => updateWorkspaceWebhook(workspaceId, id, patch),
    delete: (id) => deleteWorkspaceWebhook(workspaceId, id),
    rotateSecret: (id) => rotateWorkspaceWebhookSecret(workspaceId, id),
    test: (id) => testWorkspaceWebhook(workspaceId, id),
    listDeliveries: (id, opts) => listWorkspaceWebhookDeliveries(workspaceId, id, opts),
  };
}

const INTRO = (
  <>
    Send new releases to your team&apos;s Slack, Discord, or any URL — signed{" "}
    <code className="font-mono text-[0.9em]">release.created</code> POSTs for one org this workspace
    tracks. Everyone in the workspace can see these.{" "}
    <Link href="/docs/api/webhooks" className="underline underline-offset-2">
      Docs
    </Link>
  </>
);

/**
 * `/account/workspace-webhooks` (#2324) — workspace-owned webhooks, backed by
 * `GET/POST /v1/workspaces/:workspaceId/webhooks` and siblings. Any member can
 * view and send a test; only owners/admins can add, edit, rotate, or delete
 * ({@link WorkspaceMemberRole}) — enforced server-side, mirrored here via the
 * list response's `canManage` so the UI doesn't offer actions that will 403.
 */
export function WorkspaceWebhooksPanel() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;
  const { workspaces, active, isLoading: workspacesLoading } = useWorkspaces();
  const current = active ?? (!workspacesLoading ? (workspaces[0] ?? null) : null);
  const searchParams = useSearchParams();

  const [subs, setSubs] = useState<UserWebhookListItem[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const currentId = current?.id;
  const client = useMemo(() => (currentId ? makeWorkspaceClient(currentId) : null), [currentId]);
  useEffect(() => {
    if (!currentId) return;
    // Clear the previous workspace's rows and ignore out-of-order responses.
    let cancelled = false;
    setSubs(null);
    setCanManage(false);
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await listWorkspaceWebhooks(currentId);
        if (cancelled) return;
        setSubs(res.subscriptions);
        setCanManage(res.canManage);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load workspace webhooks.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentId]);

  if (isPending || (user && workspacesLoading && !current)) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (!user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account/workspace-webhooks" className="underline">
          sign in
        </Link>{" "}
        to manage workspace webhooks.
      </p>
    );
  }

  if (!current || !client) {
    return (
      <p className="rounded-xl border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
        You don&apos;t have a workspace yet. Create one from the switcher in the sidebar.
      </p>
    );
  }

  if (loading && subs == null) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (error) {
    return <p className="text-[13px] text-red-600 dark:text-red-400">{error}</p>;
  }

  const createPrefill = parseWebhookCreatePrefill({
    org: searchParams.get("org"),
  });

  return (
    <WebhooksPanel
      key={current.id}
      initialWebhooks={subs ?? []}
      createPrefill={createPrefill}
      client={client}
      allowFollows={false}
      canManage={canManage}
      intro={INTRO}
    />
  );
}
