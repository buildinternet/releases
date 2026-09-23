"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/**
 * Hides the org context rail on admin-only tabs (Admin, and optionally other
 * full-width curator surfaces) so the settings panel's own aside isn't cramped
 * into a three-column layout.
 */
export function OrgContextRailGate({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  if (pathname.endsWith("/admin")) return null;
  return children;
}
