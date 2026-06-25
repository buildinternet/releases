"use client";

import { useEffect, useState } from "react";
import { workspaceInitial } from "@/components/account/use-workspaces";

/** Workspace tile — custom logo when set, else the name initial. */
export function WorkspaceAvatar({ name, logo }: { name: string; logo?: string | null }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [logo]);
  if (logo && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logo}
        alt=""
        decoding="async"
        onError={() => setBroken(true)}
        className="h-full w-full object-cover"
      />
    );
  }
  return <span aria-hidden="true">{workspaceInitial(name)}</span>;
}
