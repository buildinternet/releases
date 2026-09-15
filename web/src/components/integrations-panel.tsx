"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  PanelGrid,
  ErrorText,
  SuccessBanner,
  cardClass,
  smallButtonClass,
} from "@releases/design-system";
import { PromoRail } from "@/components/account/promo-rail";
import { CheckIcon } from "@/components/account/icons";
import { useSession } from "@/lib/auth-client";
import { useWorkspaces } from "@/components/account/use-workspaces";
import {
  disconnectUploads,
  fetchUploadsIntegration,
  startUploadsConnect,
} from "@/lib/uploads-oauth";
import type { UploadsIntegrationStatus } from "@buildinternet/releases-api-types";

function resultFromQuery(
  params: ReturnType<typeof useSearchParams>,
): "connected" | "denied" | "error" | null {
  const value = params.get("uploads");
  if (value === "connected" || value === "denied" || value === "error") return value;
  return null;
}

export function IntegrationsPanel() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;
  const { workspaces, active, isLoading: workspacesLoading } = useWorkspaces();
  const current = active ?? (!workspacesLoading ? (workspaces[0] ?? null) : null);
  const searchParams = useSearchParams();
  const flash = resultFromQuery(searchParams);

  const [status, setStatus] = useState<UploadsIntegrationStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (workspaceId: string) => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchUploadsIntegration(workspaceId));
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : "Failed to load uploads connection");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!current) return;
    void load(current.id);
  }, [current?.id, load]);

  async function onConnect() {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const { authorizeUrl } = await startUploadsConnect(current.id);
      window.location.assign(authorizeUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start connect");
      setBusy(false);
    }
  }

  async function onDisconnect() {
    if (!current) return;
    if (!window.confirm("Disconnect uploads.sh from this workspace?")) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await disconnectUploads(current.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setBusy(false);
    }
  }

  if (isPending || (user && workspacesLoading && !current)) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (!user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account/integrations" className="underline">
          sign in
        </Link>{" "}
        to connect integrations for a workspace.
      </p>
    );
  }

  const connected = status?.connected === true;
  const configured = status?.configured !== false;

  return (
    <PanelGrid aside={<PromoRail />}>
      <div className="flex flex-col gap-6">
        {flash === "connected" && (
          <SuccessBanner>uploads.sh is connected to this workspace.</SuccessBanner>
        )}
        {flash === "denied" && <ErrorText>The uploads authorization was cancelled.</ErrorText>}
        {flash === "error" && (
          <ErrorText>Could not complete the uploads connection. Try again.</ErrorText>
        )}
        {error && <ErrorText>{error}</ErrorText>}

        <div className={`flex items-start gap-3.5 ${cardClass} p-[17px]`}>
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-stone-100 font-mono text-[15px] font-semibold text-stone-700 dark:bg-stone-800 dark:text-stone-200">
            UP
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              uploads.sh
            </div>
            <p className="mt-0.5 mb-3 text-[12.5px] leading-snug text-stone-500 dark:text-stone-400">
              Connect an uploads.sh account so this workspace can use files from it. Revoke the
              grant anytime under Connected apps on uploads.sh.
            </p>
            {loading && !status ? (
              <p className="text-[12.5px] text-stone-500 dark:text-stone-400">Loading…</p>
            ) : connected ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--accent)]">
                  <CheckIcon className="h-3.5 w-3.5" />
                  Connected
                  {status?.connectedAt
                    ? ` · ${new Date(status.connectedAt).toLocaleDateString()}`
                    : ""}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onDisconnect()}
                  className={smallButtonClass}
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={busy || !configured}
                onClick={() => void onConnect()}
                className={`${smallButtonClass} ${!configured ? "cursor-not-allowed opacity-60" : ""}`}
              >
                Connect uploads
              </button>
            )}
            {!configured && !connected && (
              <p className="mt-2 text-[12.5px] text-stone-500 dark:text-stone-400">
                uploads OAuth is not configured on this Index instance.
              </p>
            )}
          </div>
        </div>
      </div>
    </PanelGrid>
  );
}
