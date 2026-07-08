import { GITHUB_REPO_URL } from "./nav-items";

// Fetch the monorepo's star count from the public GitHub API. Cached in Next's
// data cache for an hour so we make at most one request per hour (well under
// the 60/hr unauthenticated limit), and every render reuses the cached value.
// Any failure returns null and the CTA simply renders without a count.
async function fetchStarCount(): Promise<number | null> {
  try {
    const res = await fetch("https://api.github.com/repos/buildinternet/releases", {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: unknown };
    return typeof data.stargazers_count === "number" ? data.stargazers_count : null;
  } catch {
    return null;
  }
}

function formatStarCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

// Header call-to-action linking to the open-source monorepo. Progressive by
// width: the GitHub mark keeps it recognizable at any size, the "Star on
// GitHub" label appears once there's room (xl+), and the live star count rides
// along whenever the API call succeeded.
export async function GitHubStar() {
  const stars = await fetchStarCount();
  return (
    <a
      href={GITHUB_REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Star Releases on GitHub"
      className="group inline-flex items-center gap-1.5 rounded-md border border-stone-300 dark:border-stone-700 px-2 py-1 text-stone-600 dark:text-stone-300 hover:border-stone-400 hover:text-stone-900 dark:hover:border-stone-500 dark:hover:text-stone-100 transition-colors"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="h-[18px] w-[18px] shrink-0 fill-current"
      >
        <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1-.02-1.96-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.05 11.05 0 0 1 5.78 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.68.8.56C20.71 21.39 24 17.08 24 12 24 5.73 18.77.5 12 .5Z" />
      </svg>
      <span className="hidden xl:inline text-sm font-medium leading-none whitespace-nowrap">
        Star on GitHub
      </span>
      {stars != null ? (
        <span className="inline-flex items-center gap-1 border-l border-stone-300 dark:border-stone-700 pl-1.5 text-sm font-medium leading-none tabular-nums">
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 fill-amber-500 dark:fill-amber-400"
          >
            <path d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.1-6.46-4.69-4.58 6.49-.94L12 2.5z" />
          </svg>
          {formatStarCount(stars)}
        </span>
      ) : null}
    </a>
  );
}
