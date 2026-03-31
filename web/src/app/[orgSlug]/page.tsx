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

export default async function OrgPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;

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

  const activity = await api.orgActivity(org.slug).catch(() => null);

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
        { label: "Avg per Week", value: org.avgReleasesPerWeek, large: true, subtitle: "releases" },
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
        <div className="pt-5 text-[13px] text-stone-400">
          <Link href="/" className="hover:text-stone-600">Home</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 font-medium">{org.name}</span>
        </div>
        <h1 className="text-[28px] font-bold tracking-tight text-stone-900 mt-4">{org.name}</h1>
        {activity && <ReleaseTimeline activity={activity} />}
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
