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
import { CheckIcon, ExternalLinkIcon } from "@/components/account/icons";
import { useSession } from "@/lib/auth-client";
import { useWorkspaces } from "@/components/account/use-workspaces";
import {
  disconnectUploads,
  fetchUploadsIntegration,
  startUploadsConnect,
} from "@/lib/uploads-oauth";
import type { UploadsIntegrationStatus } from "@buildinternet/releases-api-types";

const UPLOADS_HOME = "https://uploads.sh";
const UPLOADS_ICON_SVG = "https://uploads.sh/favicon.svg";
const UPLOADS_ICON_PNG = "https://uploads.sh/apple-touch-icon.png";

function resultFromQuery(
  params: ReturnType<typeof useSearchParams>,
): "connected" | "denied" | "error" | null {
  const value = params.get("uploads");
  if (value === "connected" || value === "denied" || value === "error") return value;
  return null;
}

function UploadsMark() {
  const [src, setSrc] = useState(UPLOADS_ICON_SVG);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span className="font-mono text-[15px] font-semibold text-stone-700 dark:text-stone-200">
        U
      </span>
    );
  }

  return (
    // Favicon / touch-icon from uploads.sh — not in next/image remotePatterns.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={40}
      height={40}
      decoding="async"
      className="h-10 w-10 object-contain p-1.5"
      onError={() => {
        if (src === UPLOADS_ICON_SVG) setSrc(UPLOADS_ICON_PNG);
        else setFailed(true);
      }}
    />
  );
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
      setError(err instanceof Error ? err.message : "Failed to load Uploads connection");
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
    if (!window.confirm("Disconnect Uploads from this workspace?")) return;
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
  const uploadsWorkspace = connected ? (status?.uploadsWorkspace ?? null) : null;

  return (
    <PanelGrid aside={<PromoRail />}>
      <div className="flex flex-col gap-6">
        {flash === "connected" && (
          <SuccessBanner>Uploads is connected to this workspace.</SuccessBanner>
        )}
        {flash === "denied" && <ErrorText>The Uploads authorization was cancelled.</ErrorText>}
        {flash === "error" && (
          <ErrorText>Could not complete the Uploads connection. Try again.</ErrorText>
        )}
        {error && <ErrorText>{error}</ErrorText>}

        <div className={`flex items-start gap-3.5 ${cardClass} p-[17px]`}>
          <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[11px] bg-stone-100 dark:bg-stone-800">
            <UploadsMark />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">Uploads</div>
              <a
                href={UPLOADS_HOME}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open Uploads"
                className="text-stone-400 transition-colors hover:text-stone-700 dark:text-stone-500 dark:hover:text-stone-200"
              >
                <ExternalLinkIcon className="h-3.5 w-3.5" />
              </a>
            </div>
            <p className="mt-0.5 mb-3 text-[12.5px] leading-snug text-stone-500 dark:text-stone-400">
              Connect an Uploads account so this workspace can use files from it. Revoke the grant
              anytime under Connected apps on Uploads.
            </p>
            {loading && !status ? (
              <p className="text-[12.5px] text-stone-500 dark:text-stone-400">Loading…</p>
            ) : connected ? (
              <div className="flex flex-col gap-2">
                {uploadsWorkspace ? (
                  <p className="text-[12.5px] text-stone-500 dark:text-stone-400">
                    Workspace{" "}
                    <span className="font-mono text-stone-700 dark:text-stone-200">
                      {uploadsWorkspace}
                    </span>
                  </p>
                ) : null}
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
              </div>
            ) : (
              <button
                type="button"
                disabled={busy || !configured}
                onClick={() => void onConnect()}
                className={`${smallButtonClass} ${!configured ? "cursor-not-allowed opacity-60" : ""}`}
              >
                Connect Uploads
              </button>
            )}
            {!configured && !connected && (
              <p className="mt-2 text-[12.5px] text-stone-500 dark:text-stone-400">
                Uploads OAuth is not configured on this Index instance.
              </p>
            )}
          </div>
        </div>
      </div>
    </PanelGrid>
  );
}
