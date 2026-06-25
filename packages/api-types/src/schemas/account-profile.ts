import { z } from "zod";

/** Response shared by user + workspace avatar upload routes. */
export const UploadAvatarResponseSchema = z.object({
  avatarUrl: z.string(),
  key: z.string(),
  width: z.number(),
  height: z.number(),
});

export const WorkspaceProfileFieldsSchema = z.object({
  websiteUrl: z.string().nullable(),
  changelogUrl: z.string().nullable(),
  githubHandle: z.string().nullable(),
});

/** Body for `PATCH /v1/me/workspaces/:organizationId/profile`. */
export const PatchWorkspaceProfileBodySchema = z.object({
  websiteUrl: z.string().nullable().optional(),
  changelogUrl: z.string().nullable().optional(),
  githubHandle: z.string().nullable().optional(),
});

export const WorkspaceProfileResponseSchema = z.object({
  organizationId: z.string(),
  logo: z.string().nullable(),
  profile: WorkspaceProfileFieldsSchema,
});
