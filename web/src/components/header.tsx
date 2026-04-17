import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";

const GITHUB_REPO_URL = "https://github.com/buildinternet/releases-cli";

export function Header() {
  return (
    <header className="border-b border-stone-200 dark:border-stone-800 px-6 py-4 flex items-center justify-between">
      <Link href="/" className="font-bold text-lg tracking-tight text-stone-900 dark:text-stone-100 flex items-center gap-2">releases.sh<span className="text-[10px] font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500 border border-stone-300 dark:border-stone-700 rounded px-1.5 py-0.5 leading-none">preview</span></Link>
      <nav className="flex items-center gap-5 text-sm text-stone-500 dark:text-stone-400">
        <Link href="/search" className="hover:text-stone-700 dark:hover:text-stone-300">Search</Link>
        <Link href="/docs" className="hover:text-stone-700 dark:hover:text-stone-300">Docs</Link>
        {process.env.NODE_ENV === "development" && <Link href="/status" className="hover:text-stone-700 dark:hover:text-stone-300">Status</Link>}
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Releases CLI on GitHub"
          className="hover:text-stone-700 dark:hover:text-stone-300"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="h-[18px] w-[18px] fill-current"
          >
            <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1-.02-1.96-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.05 11.05 0 0 1 5.78 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.68.8.56C20.71 21.39 24 17.08 24 12 24 5.73 18.77.5 12 .5Z" />
          </svg>
        </a>
        <ThemeToggle />
      </nav>
    </header>
  );
}
