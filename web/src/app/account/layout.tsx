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
      <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-6 px-6 py-8 md:flex-row md:gap-10 md:py-10">
        <AccountSettingsNav />
        <main className="min-w-0 flex-1 pb-16 md:border-l md:border-stone-200 md:pb-24 md:pl-10 md:dark:border-stone-800">
          {children}
        </main>
      </div>
    </div>
  );
}
