"use client";

import type {
  PatchWorkspaceProfileBody,
  UploadAvatarResponse,
  WorkspaceProfileResponse,
} from "@buildinternet/releases-api-types";
import { apiBase, errorMessage } from "./user-api";

async function postAvatar(path: string, file: File): Promise<UploadAvatarResponse> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Upload failed (${res.status})`));
  return (await res.json()) as UploadAvatarResponse;
}

export function uploadUserAvatar(file: File): Promise<UploadAvatarResponse> {
  return postAvatar("/v1/me/avatar", file);
}

export function uploadWorkspaceAvatar(
  organizationId: string,
  file: File,
): Promise<UploadAvatarResponse> {
  return postAvatar(`/v1/me/workspaces/${organizationId}/avatar`, file);
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
