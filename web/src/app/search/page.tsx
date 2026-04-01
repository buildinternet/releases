import { api } from "@/lib/api";
import { Header } from "@/components/header";
import { SearchBar } from "@/components/search-bar";
import Link from "next/link";

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;

  let results = null;
  if (q && q.trim()) {
    try {
      results = await api.search(q);
    } catch {
      results = { query: q, results: [] };
    }
  }

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-2xl mx-auto px-6 pt-12 pb-12">
        <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100 mb-6 text-center">Search</h1>
        <SearchBar defaultValue={q} />
        {results && (
          <div className="mt-8">
            {results.results.length === 0 ? (
              <p className="text-center text-stone-400 dark:text-stone-500 text-sm">No results for &ldquo;{q}&rdquo;</p>
            ) : (
              <div>
                {results.results.map((r, i) => {
                  const href = r.orgSlug ? `/${r.orgSlug}/${r.sourceSlug}` : `/source/${r.sourceSlug}`;
                  return (
                    <div key={i} className="border-b border-stone-200 dark:border-stone-800 py-4 first:pt-0 last:border-b-0">
                      <div className="flex justify-between items-baseline mb-1">
                        <div className="flex items-baseline gap-2">
                          {r.version && <span className="font-semibold text-[15px] text-stone-900 dark:text-stone-100">{r.version}</span>}
                          <span className="text-sm text-stone-600 dark:text-stone-400">{r.title}</span>
                        </div>
                        <span className="text-xs text-stone-400 dark:text-stone-500 whitespace-nowrap ml-4">{formatDate(r.publishedAt)}</span>
                      </div>
                      <p className="text-[13px] text-stone-500 dark:text-stone-400 mb-1">{r.summary}</p>
                      <Link href={href} className="text-xs text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300">{r.sourceName}</Link>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
