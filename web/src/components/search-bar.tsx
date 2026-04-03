"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";

export function SearchBar({
  defaultValue,
  className,
}: {
  defaultValue?: string;
  className?: string;
}) {
  const router = useRouter();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function updateUrl(value: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      const url = value.trim()
        ? `/search?q=${encodeURIComponent(value.trim())}`
        : "/search";
      router.replace(url, { scroll: false });
    }, 300);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const input = e.currentTarget.elements.namedItem("q") as HTMLInputElement;
    const value = input.value.trim();
    const url = value ? `/search?q=${encodeURIComponent(value)}` : "/search";
    router.replace(url, { scroll: false });
  }

  return (
    <form onSubmit={handleSubmit} className={className}>
      <input
        name="q"
        type="text"
        defaultValue={defaultValue}
        onChange={(e) => updateUrl(e.target.value)}
        placeholder="Search organizations, products, and releases..."
        className="w-full bg-white dark:bg-stone-900 border border-stone-300 dark:border-stone-700 rounded-lg px-4 py-2.5 text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 outline-none focus:border-stone-400 dark:focus:border-stone-500 transition-colors"
      />
    </form>
  );
}
