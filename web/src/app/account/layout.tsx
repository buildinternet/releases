import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { AccountSettingsNav } from "@/components/account-settings-nav";
import { AUTH_CONFIGURED } from "@/lib/auth-ui";

export default function AccountLayout({ children }: { children: ReactNode }) {
  if (!AUTH_CONFIGURED) {
    notFound();
  }

  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10 md:flex-row md:gap-12">
        <AccountSettingsNav />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
