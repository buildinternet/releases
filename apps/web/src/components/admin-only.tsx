"use client";

import type { ReactNode } from "react";
import { useSession } from "@/lib/auth-client";

/** Pure predicate (unit-tested): admin when role is `admin` or the dev override is on. */
export function computeIsAdmin(role: string | null | undefined, devAdmin: boolean): boolean {
  return devAdmin || role === "admin";
}

/**
 * Client hook: is the current viewer an admin? `devAdmin` is the server-evaluated
 * local-dev override (`isLocalAdminEnabled()`), passed down so the keyless local
 * workflow still shows admin UI when no user is signed in.
 */
export function useIsAdmin(devAdmin = false): boolean {
  const { data } = useSession();
  const role = (data?.user as { role?: string } | undefined)?.role ?? null;
  return computeIsAdmin(role, devAdmin);
}

/**
 * Mounts `children` only for admins. Server parents render this around an admin
 * menu and pass `devAdmin`; the menu's own hooks run only when an admin is
 * present (the element is created server-side but rendered client-side only when
 * `useIsAdmin` is true), so anonymous SSR output — and thus page caching — is
 * unaffected. This is cosmetic gating: the server actions the menu calls enforce
 * admin at the API regardless.
 */
export function AdminOnly({
  devAdmin = false,
  children,
}: {
  devAdmin?: boolean;
  children: ReactNode;
}): ReactNode {
  return useIsAdmin(devAdmin) ? children : null;
}
