"use client";

import { workspaceInitial } from "@/components/account/use-workspaces";
import { StableImageAvatar } from "@/components/account/stable-image-avatar";

/** Workspace tile — custom logo when set, else the name initial. */
export function WorkspaceAvatar({ name, logo }: { name: string; logo?: string | null }) {
  return <StableImageAvatar src={logo} fallback={workspaceInitial(name)} />;
}
