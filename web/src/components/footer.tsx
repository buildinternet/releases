import Link from "next/link";

const GITHUB_REPO_URL = "https://github.com/buildinternet/releases-cli";

export function Footer() {
  return (
    <footer
      className="border-t border-stone-200 dark:border-stone-800 mt-auto"
      style={{ viewTransitionName: "site-footer" }}
    >
      <div className="max-w-5xl mx-auto px-6 py-6 flex flex-wrap items-center justify-between gap-4 text-xs text-stone-500 dark:text-stone-400">
        <div>
          <div>
            <Link href="/" className="font-medium hover:text-stone-700 dark:hover:text-stone-300">
              releases.sh
            </Link>
            <span className="mx-2 text-stone-300 dark:text-stone-700">·</span>
            <span>A changelog registry for agents and developers.</span>
          </div>
          <div className="mt-1 text-stone-400 dark:text-stone-500">
            Maintained by{" "}
            <a
              href="https://zachdunn.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-stone-700 dark:hover:text-stone-300 underline-offset-2 hover:underline"
            >
              Zach Dunn
            </a>{" "}
            /{" "}
            <a
              href="https://buildinternet.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-stone-700 dark:hover:text-stone-300 underline-offset-2 hover:underline"
            >
              Build Internet
            </a>
            .
          </div>
        </div>
        <nav className="flex items-center gap-4">
          <Link href="/live" className="hover:text-stone-700 dark:hover:text-stone-300">
            Live
          </Link>
          <Link href="/privacy" className="hover:text-stone-700 dark:hover:text-stone-300">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-stone-700 dark:hover:text-stone-300">
            Terms
          </Link>
          <Link href="/security" className="hover:text-stone-700 dark:hover:text-stone-300">
            Security
          </Link>
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-stone-700 dark:hover:text-stone-300"
          >
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
