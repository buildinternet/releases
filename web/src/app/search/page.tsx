import type { Metadata } from "next";
import { Suspense } from "react";
import { api } from "@/lib/api";
import { Header } from "@/components/header";
import { SearchBar } from "@/components/search-bar";
import { SearchResults } from "@/components/search-results";
import { InlineCopyCode } from "@/components/inline-copy-code";
import type { UnifiedSearchResponse } from "@/lib/api";

export const metadata: Metadata = {
  title: "Search",
  alternates: { canonical: "/search" },
  robots: { index: false, follow: true },
};

async function SearchContent({ q }: { q?: string }) {
  let results: UnifiedSearchResponse | null = null;
  if (q && q.trim()) {
    try {
      results = await api.search(q);
    } catch {
      results = { query: q, orgs: [], products: [], sources: [], releases: [] };
    }
  }

  return <SearchResults query={q} results={results} />;
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-2xl mx-auto px-6 pt-12 pb-12">
        <h1 className="text-2xl font-semibold mb-4">Search</h1>
        <SearchBar defaultValue={q} />
        <p className="mt-2 text-[12px] text-stone-400 dark:text-stone-500">
          From the CLI:{" "}
          <InlineCopyCode
            code={`npx @buildinternet/releases search "${(q?.trim() || "vercel").replace(/"/g, '\\"')}"`}
          />
        </p>
        <Suspense>
          <SearchContent q={q} />
        </Suspense>
      </div>
    </div>
  );
}
