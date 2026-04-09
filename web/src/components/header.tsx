import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";
import { publicDocs } from "@/flags";

export async function Header() {
  const docsEnabled = await publicDocs();

  return (
    <header className="border-b border-stone-200 dark:border-stone-800 px-6 py-4 flex items-center justify-between">
      <Link href="/" className="font-bold text-lg tracking-tight text-stone-900 dark:text-stone-100 flex items-center gap-2">releases.sh<span className="text-[10px] font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500 border border-stone-300 dark:border-stone-700 rounded px-1.5 py-0.5 leading-none">preview</span></Link>
      <nav className="flex items-center gap-5 text-sm text-stone-500 dark:text-stone-400">
        <Link href="/" className="hover:text-stone-700 dark:hover:text-stone-300">Browse</Link>
        <Link href="/search" className="hover:text-stone-700 dark:hover:text-stone-300">Search</Link>
        {docsEnabled && <Link href="/docs" className="hover:text-stone-700 dark:hover:text-stone-300">Docs</Link>}
        <ThemeToggle />
      </nav>
    </header>
  );
}
