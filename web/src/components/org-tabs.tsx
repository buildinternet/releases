"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useIsAdmin } from "@/components/admin-only";

function CodeBrackets() {
  return (
    <svg
      className="-mt-px mr-1 inline-block h-3.5 w-3.5 opacity-50"
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

function orgTabClass(active: boolean): string {
  return `-mb-px border-b-2 py-3 text-[14px] transition-colors ${
    active
      ? "border-[var(--accent)] font-semibold text-[var(--fg)]"
      : "border-transparent font-medium text-[var(--fg-2)] hover:text-[var(--fg)]"
  }`;
}

const railLinkClass =
  "inline-flex items-center gap-1.5 py-3 text-[13px] text-[var(--fg-3)] transition-colors hover:text-[var(--fg-2)]";

export function OrgTabs({
  orgSlug,
  devAdmin = false,
  latestReleaseAt = null,
}: {
  orgSlug: string;
  /** Server-evaluated local-dev admin override, forwarded to {@link useIsAdmin}. */
  devAdmin?: boolean;
  /** ISO timestamp of the org's most recent release — drives the "new" dot. */
  latestReleaseAt?: string | null;
}) {
  const pathname = usePathname() ?? "";
  const activeTab = resolveActiveTab(pathname, orgSlug);
  const base = `/${orgSlug}`;
  // Admin-only surfaces. Gated client-side (like AdminOnly) so the org layout
  // stays statically cacheable; the routes themselves enforce admin server-side.
  const showAdminTabs = useIsAdmin(devAdmin);

  // "New releases" dot: shown when the latest release is newer than what this
  // visitor has already seen (tracked in localStorage, keyed by org). The first
  // visit sets a baseline so the dot doesn't fire for everyone — it only lights
  // up when something ships after you last looked, and clears once you open the
  // Releases tab. Driven entirely from an effect so SSR and the first client
  // render stay identical (no hydration mismatch).
  const [showDot, setShowDot] = useState(false);
  const seenKey = `releases:seen:${orgSlug}`;

  useEffect(() => {
    if (!latestReleaseAt) return;
    let seen: string | null = null;
    try {
      seen = localStorage.getItem(seenKey);
    } catch {
      return;
    }
    if (seen === null) {
      try {
        localStorage.setItem(seenKey, latestReleaseAt);
      } catch {
        /* storage unavailable — degrade to no dot */
      }
      return;
    }
    setShowDot(latestReleaseAt > seen);
  }, [latestReleaseAt, seenKey]);

  useEffect(() => {
    if (activeTab !== "releases" || !latestReleaseAt) return;
    try {
      localStorage.setItem(seenKey, latestReleaseAt);
    } catch {
      /* ignore */
    }
    setShowDot(false);
  }, [activeTab, latestReleaseAt, seenKey]);

  return (
    <div className="flex items-center gap-6 border-b border-[var(--line)]">
      <Link href={base} className={orgTabClass(activeTab === "overview")} scroll={false}>
        Overview
      </Link>
      <Link
        href={`${base}/releases`}
        className={orgTabClass(activeTab === "releases")}
        scroll={false}
      >
        Releases
        {showDot && (
          <span
            title="New releases"
            className="org-status-dot ml-[7px] inline-block h-1.5 w-1.5 translate-y-[1px] rounded-full bg-[var(--accent)] align-middle"
          />
        )}
      </Link>
      <Link
        href={`${base}/sources`}
        className={orgTabClass(activeTab === "sources")}
        scroll={false}
      >
        Sources
      </Link>
      {showAdminTabs && (
        <div className="ml-auto flex items-center gap-5">
          <Link href={`${base}/fetch-log`} className={railLinkClass} scroll={false}>
            <CodeBrackets />
            Fetch Log
          </Link>
          <Link href={`${base}/playbook`} className={railLinkClass} scroll={false}>
            Playbook
          </Link>
        </div>
      )}
    </div>
  );
}
