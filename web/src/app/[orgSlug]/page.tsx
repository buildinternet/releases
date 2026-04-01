import { notFound } from "next/navigation";
import { api, ApiSetupError } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { SourceCard } from "@/components/source-card";
import { Sidebar } from "@/components/sidebar";
import { ReleaseTimeline } from "@/components/release-timeline";
import Link from "next/link";

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function OrgPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const yearParam = typeof sp.year === "string" ? parseInt(sp.year, 10) : undefined;

  let org;
  try {
    org = await api.orgDetail(orgSlug);
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

  // Compute the activity window: specific year or trailing 12 months
  const now = new Date();
  let activityFrom: string | undefined;
  let activityTo: string | undefined;

  if (yearParam && yearParam >= 2000 && yearParam <= now.getFullYear()) {
    activityFrom = `${yearParam}-01-01`;
    activityTo = `${yearParam}-12-31`;
  } else {
    const twoYearsAgo = new Date(now);
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    activityFrom = twoYearsAgo.toISOString().slice(0, 10);
  }

  const activity = await api.orgActivity(org.slug, activityFrom, activityTo).catch(() => null);

  // Determine available years for the year selector
  const trackingStart = org.trackingSince ? new Date(org.trackingSince).getFullYear() : now.getFullYear();
  const availableYears: number[] = [];
  for (let y = now.getFullYear(); y >= trackingStart; y--) {
    availableYears.push(y);
  }

  const sidebarSections = [
    {
      items: [
        ...(org.domain ? [{ label: "Domain", value: org.domain }] : []),
        { label: "Sources", value: org.sourceCount, large: true },
        { label: "Total Releases", value: org.releaseCount, large: true },
      ],
    },
    {
      items: [
        { label: "Last 30 Days", value: org.releasesLast30Days, large: true, subtitle: "releases" },
        { label: "Avg per Week", value: Math.round(org.avgReleasesPerWeek), large: true, subtitle: "releases" },
      ],
    },
    {
      items: [
        { label: "Last Updated", value: formatDate(org.lastFetchedAt) },
        { label: "Tracking Since", value: formatDate(org.trackingSince) },
      ],
    },
  ];

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-4xl mx-auto px-6">
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          <Link href="/" className="hover:text-stone-600 dark:hover:text-stone-300">Home</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{org.name}</span>
        </div>
        <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mt-4">{org.name}</h1>
        {activity && (
          <ReleaseTimeline
            activity={activity}
            availableYears={availableYears}
            currentYear={yearParam}
            orgSlug={org.slug}
          />
        )}
        <div className="flex gap-10 mt-6 pb-12">
          <div className="flex-1 min-w-0 space-y-2">
            {[...org.sources].sort((a, b) => {
              if (a.isPrimary && !b.isPrimary) return -1;
              if (!a.isPrimary && b.isPrimary) return 1;
              if (a.type === "github" && b.type !== "github") return 1;
              if (a.type !== "github" && b.type === "github") return -1;
              return 0;
            }).map((source) => (
              <SourceCard key={source.slug} source={source} orgSlug={org.slug} />
            ))}
          </div>
          <Sidebar sections={sidebarSections} accounts={org.accounts} formatPath={`/${orgSlug}`} />
        </div>
      </div>
    </div>
  );
}
