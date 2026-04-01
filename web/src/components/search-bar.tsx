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
        className="w-full bg-white dark:bg-stone-900 border border-stone-300 dark:border-stone-700 rounded-lg px-4 py-2.5 text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 outline-none focus:border-stone-400 dark:focus:border-stone-500 transition-colors" />
    </form>
  );
}
