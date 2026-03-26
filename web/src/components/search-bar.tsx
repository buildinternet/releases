"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SearchBar({ defaultValue }: { defaultValue?: string }) {
  const router = useRouter();
  const [query, setQuery] = useState(defaultValue ?? "");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim()) router.push(`/search?q=${encodeURIComponent(query.trim())}`);
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-[480px] mx-auto">
      <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Search releases..."
        className="w-full bg-white border border-stone-300 rounded-lg px-4 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 outline-none focus:border-stone-400 transition-colors" />
    </form>
  );
}
