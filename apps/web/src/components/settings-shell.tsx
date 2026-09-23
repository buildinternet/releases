import type { ReactNode } from "react";
import { AccountSettingsNav } from "@/components/account-settings-nav";

/** Shared chrome for `/account/*` and `/admin/*`: settings sidebar + main (site Header is in the root layout). */
export function SettingsShell({
  children,
  devAdmin = false,
}: {
  children: ReactNode;
  /** Server-evaluated local-dev admin override, forwarded to the sidebar. */
  devAdmin?: boolean;
}) {
  return (
    <div className="min-h-screen">
      <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-6 px-6 py-8 md:flex-row md:gap-10 md:py-10">
        <AccountSettingsNav devAdmin={devAdmin} />
        <main className="min-w-0 flex-1 pb-16 md:border-l md:border-stone-200 md:pb-24 md:pl-10 md:dark:border-stone-800">
          {children}
        </main>
      </div>
    </div>
  );
}
