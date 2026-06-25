"use client";

import type {
  PatchWorkspaceProfileBody,
  UploadAvatarResponse,
  WorkspaceProfileResponse,
} from "@buildinternet/releases-api-types";

function apiOrigin(): string {
  const base = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  if (!base) throw new Error("NEXT_PUBLIC_BETTER_AUTH_URL is not configured");
  return base.replace(/\/+$/, "");
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

async function postAvatar(path: string, file: File): Promise<UploadAvatarResponse> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${apiOrigin()}${path}`, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  if (!res.ok) throw new Error(await parseError(res));
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
  const res = await fetch(`${apiOrigin()}/v1/me/workspaces/${organizationId}/profile`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as WorkspaceProfileResponse;
}

export async function patchWorkspaceProfile(
  organizationId: string,
  body: PatchWorkspaceProfileBody,
): Promise<WorkspaceProfileResponse> {
  const res = await fetch(`${apiOrigin()}/v1/me/workspaces/${organizationId}/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as WorkspaceProfileResponse;
}
