"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef } from "react";

export function SearchBar({
  defaultValue,
  className,
}: {
  defaultValue?: string;
  className?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(defaultValue ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialMount = useRef(true);
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      const url = query.trim()
        ? `/search?q=${encodeURIComponent(query.trim())}`
        : "/search";
      routerRef.current.replace(url, { scroll: false });
    }, 300);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [query]);

  // Sync input when URL changes externally (e.g. back/forward)
  const searchParams = useSearchParams();
  const urlQuery = searchParams.get("q") ?? "";
  useEffect(() => {
    if (!debounceRef.current) {
      setQuery(urlQuery);
    }
  }, [urlQuery]);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const url = query.trim()
      ? `/search?q=${encodeURIComponent(query.trim())}`
      : "/search";
    router.replace(url, { scroll: false });
  }

  return (
    <form onSubmit={handleSubmit} className={className}>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search organizations, products, and releases..."
        className="w-full bg-white dark:bg-stone-900 border border-stone-300 dark:border-stone-700 rounded-lg px-4 py-2.5 text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 outline-none focus:border-stone-400 dark:focus:border-stone-500 transition-colors"
      />
    </form>
  );
}
