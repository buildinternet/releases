"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";
import type { ChangelogFileSummary } from "@/lib/api";

interface ChangelogFilePickerProps {
  files: ChangelogFileSummary[];
  activePath: string;
}

/**
 * URL-backed file picker for monorepo CHANGELOGs. Pushes the selected
 * `path` onto the current URL with `{ scroll: false }` so deep-linking
 * works (`/changelog?path=packages/next/CHANGELOG.md`) without yanking
 * the user back to the top of the page on change.
 */
export function ChangelogFilePicker({ files, activePath }: ChangelogFilePickerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const path = event.target.value;
      const params = new URLSearchParams(searchParams.toString());
      params.set("path", path);
      startTransition(() => {
        router.push(`?${params.toString()}`, { scroll: false });
      });
    },
    [router, searchParams],
  );

  return (
    <label className="inline-flex items-center gap-1.5 text-[12px] text-stone-500 dark:text-stone-400">
      <span className="sr-only">Changelog file</span>
      <select
        value={activePath}
        onChange={onChange}
        disabled={pending}
        className="rounded border border-stone-200 dark:border-stone-700 bg-transparent px-1.5 py-0.5 font-mono text-[12px] text-stone-700 dark:text-stone-300 focus:outline-none focus:ring-1 focus:ring-stone-400"
      >
        {files.map((f) => (
          <option key={f.path} value={f.path}>
            {f.path}
          </option>
        ))}
      </select>
    </label>
  );
}
