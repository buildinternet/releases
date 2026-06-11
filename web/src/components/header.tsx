import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";
import { MobileNav } from "./mobile-nav";
import { SearchBar } from "./search-bar";
import { SearchTrigger } from "./search-trigger";
import { AccountNav } from "./account-nav";
import { GITHUB_REPO_URL, visibleNavItems } from "./nav-items";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";

export function Header() {
  const adminEnabled = isLocalAdminEnabled();
  return (
    <header
      className="relative z-40 border-b border-stone-200 dark:border-stone-800 px-6 py-4 flex items-center gap-4 sm:gap-6"
      style={{ viewTransitionName: "site-header" }}
    >
      <Link
        href="/"
        className="font-bold text-base sm:text-lg tracking-tight text-stone-900 dark:text-stone-100 flex shrink-0 items-center gap-2"
      >
        <svg viewBox="0 0 64 64" aria-hidden="true" className="h-5 w-5 shrink-0">
          <rect
            width="64"
            height="64"
            rx="14"
            fill="currentColor"
            className="text-stone-900 dark:text-stone-100"
          />
          <rect
            x="14"
            y="18"
            width="28"
            height="6"
            rx="1.5"
            className="fill-stone-50 dark:fill-stone-900"
          />
          <rect
            x="14"
            y="29"
            width="22"
            height="6"
            rx="1.5"
            className="fill-stone-50/70 dark:fill-stone-900/70"
          />
          <rect x="14" y="40" width="36" height="6" rx="1.5" fill="oklch(0.60 0.18 252)" />
        </svg>
        releases.sh
        <span className="text-[10px] font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500 border border-stone-300 dark:border-stone-700 rounded px-1.5 py-0.5 leading-none">
          preview
        </span>
      </Link>
      <div className="flex min-w-0 flex-1 justify-center">
        <SearchBar className="hidden lg:block w-full max-w-[420px]" autoFocus={false} />
        <SearchTrigger className="hidden sm:flex lg:hidden w-fit" />
      </div>
      <MobileNav adminEnabled={adminEnabled} />
      <nav className="hidden sm:flex shrink-0 items-center gap-5 text-sm text-stone-500 dark:text-stone-400">
        {visibleNavItems().map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="hover:text-stone-700 dark:hover:text-stone-300"
          >
            {item.label}
          </Link>
        ))}
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Releases CLI on GitHub"
          className="hover:text-stone-700 dark:hover:text-stone-300"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[18px] w-[18px] fill-current">
            <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1-.02-1.96-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.05 11.05 0 0 1 5.78 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.68.8.56C20.71 21.39 24 17.08 24 12 24 5.73 18.77.5 12 .5Z" />
          </svg>
        </a>
        <ThemeToggle />
        <AccountNav adminEnabled={adminEnabled} />
      </nav>
    </header>
  );
}
