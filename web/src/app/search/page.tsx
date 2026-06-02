import type { Metadata } from "next";
import { api, emptyResults } from "@/lib/api";
import { Header } from "@/components/header";
import { SearchBar } from "@/components/search-bar";
import { SearchProvider } from "@/components/search-provider";
import { SearchResultsLive } from "@/components/search-results-live";
import { SearchCliHint } from "@/components/search-cli-hint";
import type { UnifiedSearchResponse } from "@/lib/api";

export const metadata: Metadata = {
  title: "Search",
  alternates: { canonical: "/search" },
  robots: { index: false, follow: true },
};

async function initialResults(q?: string): Promise<UnifiedSearchResponse | null> {
  if (!q || !q.trim()) return null;
  try {
    return await api.search(q);
  } catch {
    return emptyResults(q);
  }
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  // Server-fetch the first page of results for deep links / no-JS / first paint.
  // After hydration the SearchProvider takes over with client-side live search,
  // so typing never triggers another server route navigation.
  const results = await initialResults(q);

  return (
    <SearchProvider initialQuery={q ?? ""} initialResults={results}>
      <div className="min-h-screen">
        <Header />
        <div className="max-w-2xl mx-auto px-6 pt-12 pb-12">
          <h1 className="text-2xl font-semibold mb-4">Search</h1>
          <SearchBar />
          <SearchCliHint />
          <SearchResultsLive />
        </div>
      </div>
    </SearchProvider>
  );
}
