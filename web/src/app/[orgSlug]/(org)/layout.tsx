import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiSetupError } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { Sidebar } from "@/components/sidebar";
import { OrgAvatar } from "@/components/org-avatar";
import { OrgTabs } from "@/components/org-tabs";
import { CliCommand } from "@/components/cli-command";
import { taxonomySidebarSections, collectionsSidebarSection } from "@/components/taxonomy-chips";
import { OrgAdminMenu } from "@/components/org-admin-menu";
import { EntityNotice } from "@/components/entity-notice";
import { FollowButton } from "@/components/follow-button";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { domainHref } from "@/lib/source-display";
import { getOrg, getOrgCollections } from "../_lib/org-data";

export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  let org;
  try {
    org = await getOrg(orgSlug);
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <Header />
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    notFound();
  }

  const collections = await getOrgCollections(orgSlug);
  const hasPlaybook = process.env.NODE_ENV === "development";
  const hasFetchLog = process.env.NODE_ENV === "development";
  const adminEnabled = isLocalAdminEnabled();

  const sidebarSections = [
    {
      items: org.domain
        ? [{ label: "Domain", value: org.domain, externalLink: domainHref(org.domain) }]
        : [],
    },
    ...taxonomySidebarSections({ category: org.category, tags: org.tags }),
    ...collectionsSidebarSection(collections),
  ];

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-4xl mx-auto px-6">
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          <Link href="/" className="hover:text-stone-600 dark:hover:text-stone-300">
            Home
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{org.name}</span>
        </div>
        {org.avatarUrl || org.accounts.some((a) => a.platform === "github") ? (
          <div className="flex items-center gap-3 mt-4">
            <OrgAvatar
              avatarUrl={org.avatarUrl}
              githubHandle={org.accounts.find((a) => a.platform === "github")?.handle ?? null}
              name={org.name}
              size={40}
            />
            <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
              {org.name}
            </h1>
          </div>
        ) : (
          <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mt-4">
            {org.name}
          </h1>
        )}
        {org.id && (
          <div className="mt-3">
            <FollowButton targetType="org" targetId={org.id} />
          </div>
        )}
        <CliCommand identifier={org.slug} />
        {adminEnabled && (
          <div className="mt-2">
            <OrgAdminMenu
              orgSlug={org.slug}
              name={org.name}
              isHidden={org.isHidden ?? false}
              autoGenerateContent={org.autoGenerateContent ?? false}
              featured={org.featured ?? false}
              discovery={org.discovery}
              fetchPaused={org.fetchPaused}
              notice={org.notice}
            />
          </div>
        )}
        <EntityNotice notice={org.notice} />
        <div className="flex flex-col md:flex-row gap-10 mt-6 pb-6">
          <div className="flex-1 min-w-0">
            <OrgTabs orgSlug={orgSlug} hasPlaybook={hasPlaybook} hasFetchLog={hasFetchLog} />
            {children}
          </div>
          <Sidebar
            sections={sidebarSections}
            accounts={org.accounts}
            formatPath={`/${orgSlug}`}
            lastCheckedAt={org.lastPolledAt ?? org.lastFetchedAt}
            lastFetchedAt={org.lastFetchedAt}
            trackingSince={org.trackingSince}
          />
        </div>
      </div>
    </div>
  );
}
