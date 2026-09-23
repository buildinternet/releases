"use client";

import { StableImageAvatar } from "@/components/account/stable-image-avatar";

function initialOf(name: string | undefined, email: string): string {
  const fromName = (name ?? "").trim().slice(0, 1);
  if (fromName) return fromName.toUpperCase();
  return email.trim().slice(0, 1).toUpperCase() || "?";
}

/**
 * User avatar for account chrome + profile settings. Uses a stable image handoff
 * so provider photos don't flash the letter initial on load / refresh.
 * Plain <img> (not next/image) for third-party hosts; no-referrer for G/GH.
 */
export function UserAvatar({
  user,
}: {
  user: { name?: string | null; email: string; image?: string | null };
}) {
  return (
    <StableImageAvatar
      src={user.image}
      fallback={initialOf(user.name ?? undefined, user.email)}
      referrerPolicy="no-referrer"
    />
  );
}
