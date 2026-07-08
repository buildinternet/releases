import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { categoryDisplayName } from "@buildinternet/releases-core/categories";
import { ApiSetupError } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { OrgAvatar } from "@/components/org-avatar";
import { OrgTabs } from "@/components/org-tabs";
import { OrgAdminMenu } from "@/components/org-admin-menu";
import { AdminOnly } from "@/components/admin-only";
import { EntityNotice } from "@/components/entity-notice";
import { FollowButton } from "@/components/follow-button";
import { OrgInstallCommand } from "@/components/org/org-install-command";
import { AgentCopyButton } from "@/components/org/agent-copy-button";
import { OrgContextRail } from "@/components/org/org-context-rail";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { formatMonthYear } from "@/lib/formatters";
import { getOrg, getOrgCollections } from "../_lib/org-data";

/** Most recent release timestamp across all sources (drives the Releases "new" dot). */
function latestReleaseAt(sources: { latestDate?: string | null }[]): string | null {
  let latest: string | null = null;
  for (const s of sources) {
    if (s.latestDate && (latest === null || s.latestDate > latest)) latest = s.latestDate;
  }
  return latest;
}

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
  const devAdmin = isLocalAdminEnabled();

  const githubHandle = org.accounts.find((a) => a.platform === "github")?.handle ?? null;
  const hasAvatar = Boolean(org.avatarUrl || githubHandle);
  const trackingSince = formatMonthYear(org.trackingSince);
  const metaParts = [
    org.domain ? <span className="font-mono">{org.domain}</span> : null,
    org.category ? <span>{categoryDisplayName(org.category)}</span> : null,
    trackingSince ? <span>Tracking since {trackingSince}</span> : null,
  ].filter(Boolean) as ReactNode[];

  return (
    <div className="org-surface min-h-screen bg-[var(--page)] text-[var(--fg)]">
      <Header />
      <div className="mx-auto max-w-[1300px] px-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 pt-5 text-[13px] text-[var(--fg-3)]">
          <Link href="/" className="transition-colors hover:text-[var(--fg-2)]">
            Home
          </Link>
          <span className="text-[var(--line-2)]">/</span>
          <span className="text-[var(--fg-2)]">{org.name}</span>
        </div>

        {/* Org header. Wraps on narrow screens so the Follow/Admin actions drop
            below the name+meta instead of overlapping a squeezed title. */}
        <div className="flex flex-wrap items-start gap-x-[18px] gap-y-3 pb-5 pt-5">
          {hasAvatar && (
            <span className="flex h-[54px] w-[54px] shrink-0 items-center justify-center rounded-[14px] border border-[var(--line)] bg-[var(--surface-2)]">
              <OrgAvatar
                avatarUrl={org.avatarUrl}
                githubHandle={githubHandle}
                name={org.name}
                size={40}
              />
            </span>
          )}
          <div className="min-w-0 grow basis-[180px] pt-px">
            <h1 className="text-[27px] font-semibold leading-tight tracking-tight text-[var(--fg)]">
              {org.name}
            </h1>
            {metaParts.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-[var(--fg-3)]">
                {metaParts.map((part, i) => (
                  <span key={i} className="flex items-center gap-x-2.5">
                    {i > 0 && (
                      <span
                        className="h-[3px] w-[3px] rounded-full bg-[var(--line-2)]"
                        aria-hidden
                      />
                    )}
                    {part}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            {org.id && <FollowButton targetType="org" targetId={org.id} label={org.name} />}
            <AdminOnly devAdmin={devAdmin}>
              <OrgAdminMenu
                orgSlug={org.slug}
                name={org.name}
                isHidden={org.isHidden ?? false}
                autoGenerateContent={org.autoGenerateContent ?? false}
                featured={org.featured ?? false}
                discovery={org.discovery ?? undefined}
                fetchPaused={org.fetchPaused ?? undefined}
                notice={org.notice}
                variant="subtle"
                align="right"
              />
            </AdminOnly>
          </div>
        </div>

        {/* Action row: install command + agent copy. Stacks on narrow screens so
            the install command gets full width (otherwise it truncates to "npx …"). */}
        <div className="mb-6 flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <OrgInstallCommand identifier={org.slug} />
          <AgentCopyButton
            orgName={org.name}
            orgSlug={org.slug}
            productNames={org.products.map((p) => p.name)}
          />
        </div>

        <EntityNotice notice={org.notice} />

        {/* Tabs + (main | rail) */}
        <OrgTabs
          orgSlug={orgSlug}
          devAdmin={devAdmin}
          latestReleaseAt={latestReleaseAt(org.sources)}
        />
        <div className="flex flex-col gap-10 pb-24 pt-7 md:flex-row md:items-start">
          <main className="min-w-0 flex-1">{children}</main>
          <OrgContextRail
            domain={org.domain}
            category={org.category}
            tags={org.tags}
            collections={collections}
            accounts={org.accounts}
            trackingSince={org.trackingSince}
            lastCheckedAt={org.lastPolledAt ?? org.lastFetchedAt}
            formatPath={`/${orgSlug}`}
            report={{
              kind: "org",
              name: org.name,
              id: org.id,
              slug: org.slug,
              path: `/${org.slug}`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
