import Link from "next/link";

interface PaginationProps { page: number; totalPages: number; basePath: string; }

export function Pagination({ page, totalPages, basePath }: PaginationProps) {
  if (totalPages <= 1) return null;
  const pages: number[] = [];
  for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) pages.push(i);
  function href(p: number) { return p === 1 ? basePath : `${basePath}?page=${p}`; }

  return (
    <div className="mt-4 pt-4 border-t border-stone-200 dark:border-stone-800 flex justify-center gap-2 text-sm">
      {page > 1 ? <Link href={href(page - 1)} className="text-stone-500 hover:text-stone-700 dark:hover:text-stone-300">Previous</Link>
        : <span className="text-stone-300 dark:text-stone-600">Previous</span>}
      {pages.map((p) => (
        <Link key={p} href={href(p)}
          className={p === page ? "font-semibold text-stone-900 dark:text-stone-100 bg-stone-100 dark:bg-stone-800 px-2 py-0.5 rounded" : "text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 px-2 py-0.5"}>
          {p}
        </Link>
      ))}
      {page < totalPages ? <Link href={href(page + 1)} className="text-stone-500 hover:text-stone-700 dark:hover:text-stone-300">Next</Link>
        : <span className="text-stone-300 dark:text-stone-600">Next</span>}
    </div>
  );
}
