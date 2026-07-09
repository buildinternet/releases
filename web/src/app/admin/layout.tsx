import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { SettingsShell } from "@/components/settings-shell";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { isAdminViewer } from "@/lib/server-session";

/** Admin panels share the settings shell; non-admins get `notFound()` before any panel. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  if (!(await isAdminViewer())) notFound();

  return <SettingsShell devAdmin={isLocalAdminEnabled()}>{children}</SettingsShell>;
}
