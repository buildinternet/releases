"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useIsAdmin } from "@/components/admin-only";
import { tabButtonClass } from "@/lib/styles";

function CodeBrackets() {
  return (
    <svg
      className="inline-block w-3.5 h-3.5 mr-1 -mt-px opacity-40"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5.5 4 2 8l3.5 4" />
      <path d="M10.5 4 14 8l-3.5 4" />
    </svg>
  );
}

type OrgTab = "overview" | "releases" | "sources" | "playbook" | "fetch-log";

function resolveActiveTab(pathname: string, orgSlug: string): OrgTab {
  const base = `/${orgSlug}`;
  if (pathname === base) return "overview";
  if (pathname === `${base}/releases`) return "releases";
  if (pathname === `${base}/sources`) return "sources";
  if (pathname === `${base}/playbook`) return "playbook";
  if (pathname === `${base}/fetch-log`) return "fetch-log";
  return "overview";
}

export function OrgTabs({
  orgSlug,
  devAdmin = false,
}: {
  orgSlug: string;
  /** Server-evaluated local-dev admin override, forwarded to {@link useIsAdmin}. */
  devAdmin?: boolean;
}) {
  const pathname = usePathname() ?? "";
  const activeTab = resolveActiveTab(pathname, orgSlug);
  const base = `/${orgSlug}`;
  // Admin-only surfaces. Gated client-side (like AdminOnly) so the org layout
  // stays statically cacheable; the routes themselves enforce admin server-side.
  const showAdminTabs = useIsAdmin(devAdmin);

  return (
    <div className="flex gap-5 border-b border-stone-200 dark:border-stone-800 mt-5">
      <Link href={base} className={tabButtonClass(activeTab === "overview")} scroll={false}>
        Overview
      </Link>
      <Link
        href={`${base}/releases`}
        className={tabButtonClass(activeTab === "releases")}
        scroll={false}
      >
        Releases
      </Link>
      <Link
        href={`${base}/sources`}
        className={tabButtonClass(activeTab === "sources")}
        scroll={false}
      >
        Sources
      </Link>
      {showAdminTabs && (
        <div className="flex gap-5 ml-auto">
          <Link
            href={`${base}/fetch-log`}
            className={tabButtonClass(activeTab === "fetch-log")}
            scroll={false}
          >
            <CodeBrackets />
            Fetch Log
          </Link>
          <Link
            href={`${base}/playbook`}
            className={tabButtonClass(activeTab === "playbook")}
            scroll={false}
          >
            Playbook
          </Link>
        </div>
      )}
    </div>
  );
}
