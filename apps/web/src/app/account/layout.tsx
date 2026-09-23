import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { SettingsShell } from "@/components/settings-shell";
import { AUTH_CONFIGURED } from "@/lib/auth-ui";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";

export default function AccountLayout({ children }: { children: ReactNode }) {
  if (!AUTH_CONFIGURED) {
    notFound();
  }

  return <SettingsShell devAdmin={isLocalAdminEnabled()}>{children}</SettingsShell>;
}
