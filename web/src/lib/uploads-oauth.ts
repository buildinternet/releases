/**
 * Browser client for workspace-scoped uploads.sh OAuth connect.
 */
import type {
  UploadsIntegrationStatus,
  UploadsOAuthCallbackResponse,
  UploadsOAuthConnectResponse,
} from "@buildinternet/releases-api-types";
import { apiBase, errorMessage } from "./user-api";

export async function fetchUploadsIntegration(
  workspaceId: string,
): Promise<UploadsIntegrationStatus> {
  const res = await fetch(
    `${apiBase()}/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/uploads`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to load uploads connection"));
  return (await res.json()) as UploadsIntegrationStatus;
}

export async function startUploadsConnect(
  workspaceId: string,
): Promise<UploadsOAuthConnectResponse> {
  const res = await fetch(
    `${apiBase()}/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/uploads/connect`,
    { method: "POST", credentials: "include" },
  );
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to start uploads connect"));
  return (await res.json()) as UploadsOAuthConnectResponse;
}

export async function completeUploadsCallback(
  code: string,
  state: string,
): Promise<UploadsOAuthCallbackResponse> {
  const res = await fetch(`${apiBase()}/v1/integrations/uploads/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ code, state }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to complete uploads connect"));
  return (await res.json()) as UploadsOAuthCallbackResponse;
}

export async function disconnectUploads(workspaceId: string): Promise<UploadsIntegrationStatus> {
  const res = await fetch(
    `${apiBase()}/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/uploads`,
    { method: "DELETE", credentials: "include" },
  );
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to disconnect uploads"));
  return (await res.json()) as UploadsIntegrationStatus;
}
