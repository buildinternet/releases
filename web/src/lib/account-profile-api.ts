"use client";

import type {
  PatchWorkspaceProfileBody,
  UploadAvatarResponse,
  WorkspaceProfileResponse,
} from "@buildinternet/releases-api-types";
import { apiBase, errorMessage } from "./user-api";

/** Same-origin proxy cap (Vercel serverless body limit); API ingest allows 8MB. */
const AVATAR_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

async function postAvatar(sameOriginPath: string, file: File): Promise<UploadAvatarResponse> {
  if (file.size > AVATAR_UPLOAD_MAX_BYTES) {
    throw new Error(`Image exceeds the ${AVATAR_UPLOAD_MAX_BYTES}-byte upload cap`);
  }
  const form = new FormData();
  form.append("file", file);
  // Same-origin proxy — avoids credentialed cross-origin multipart to api.releases.sh,
  // which can be edge-blocked (403) without CORS headers and surfaces as "Failed to fetch".
  const res = await fetch(sameOriginPath, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Upload failed (${res.status})`));
  return (await res.json()) as UploadAvatarResponse;
}

export function uploadUserAvatar(file: File): Promise<UploadAvatarResponse> {
  return postAvatar("/api/account/me/avatar", file);
}

export function uploadWorkspaceAvatar(
  organizationId: string,
  file: File,
): Promise<UploadAvatarResponse> {
  return postAvatar(`/api/account/me/workspaces/${organizationId}/avatar`, file);
}

export async function fetchWorkspaceProfile(
  organizationId: string,
): Promise<WorkspaceProfileResponse> {
  const res = await fetch(`${apiBase()}/v1/me/workspaces/${organizationId}/profile`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Request failed (${res.status})`));
  return (await res.json()) as WorkspaceProfileResponse;
}

export async function patchWorkspaceProfile(
  organizationId: string,
  body: PatchWorkspaceProfileBody,
): Promise<WorkspaceProfileResponse> {
  const res = await fetch(`${apiBase()}/v1/me/workspaces/${organizationId}/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Request failed (${res.status})`));
  return (await res.json()) as WorkspaceProfileResponse;
}
