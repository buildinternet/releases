import { notFound, redirect } from "next/navigation";
import { api } from "@/lib/api";
import { Header } from "@/components/header";
import { SourceTypeIcon } from "@/components/source-type-icon";
import { ReleaseListItem } from "@/components/release-item";
import { Pagination } from "@/components/pagination";
import { Sidebar } from "@/components/sidebar";
import Link from "next/link";

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function safeHostname(url: string) {
  try { return new URL(url).hostname; } catch { return url; }
}

export default async function SourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; sourceSlug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { orgSlug, sourceSlug } = await params;
  const { page: pageParam } = await searchParams;
  const page = parseInt(pageParam ?? "1", 10) || 1;

  let source;
  try {
    source = await api.sourceDetail(sourceSlug, page);
  } catch {
    notFound();
  }

  if (source.org && source.org.slug !== orgSlug) {
    redirect(`/${source.org.slug}/${source.slug}`);
  }
  if (!source.org) {
    redirect(`/source/${source.slug}`);
  }

  const sidebarSections = [
    { items: [{ label: "Releases", value: source.releaseCount, large: true }] },
    {
      items: [
        { label: "Last 30 Days", value: source.releasesLast30Days, large: true, subtitle: "releases" },
        { label: "Avg per Week", value: source.avgReleasesPerWeek, large: true, subtitle: "releases" },
      ],
    },
    {
      items: [
        { label: "Latest", value: source.latestVersion, subtitle: formatDate(source.latestDate) },
        { label: "Organization", value: source.org.name, link: `/${source.org.slug}` },
        { label: "Source", value: safeHostname(source.url), externalLink: source.url },
        { label: "Tracking Since", value: formatDate(source.trackingSince) },
      ],
    },
  ];

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-4xl mx-auto px-6">
        <div className="pt-5 text-[13px] text-stone-400">
          <Link href={`/${source.org.slug}`} className="hover:text-stone-600">{source.org.name}</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 font-medium">{source.name}</span>
        </div>
        <div className="flex items-center gap-2.5 mt-4">
          <h1 className="text-[28px] font-bold tracking-tight text-stone-900">{source.name}</h1>
          <SourceTypeIcon type={source.type} size={18} />
        </div>
        <div className="flex gap-10 mt-6 pb-12">
          <div className="flex-1 min-w-0">
            {source.releases.map((release, i) => (
              <ReleaseListItem key={i} release={release} />
            ))}
            <Pagination page={source.pagination.page} totalPages={source.pagination.totalPages} basePath={`/${orgSlug}/${sourceSlug}`} />
          </div>
          <Sidebar sections={sidebarSections} />
        </div>
      </div>
    </div>
  );
}
