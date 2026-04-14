import { SourceTypeIcon } from "@/components/source-type-icon";

export function formatSourceDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function shortUrl(url: string) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    return path && path !== "/" ? u.hostname + path : u.hostname;
  } catch { return url; }
}

function githubRepoHandle(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
    const [owner, repo] = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (!owner || !repo) return null;
    return `@${owner}/${repo}`;
  } catch { return null; }
}

interface SourceSidebarItem {
  label: string;
  value: React.ReactNode;
  externalLink?: string;
}

/** Sidebar row for the source URL — GitHub sources get the @org/repo handle + icon. */
export function sourceUrlSidebarItem(source: { type: string; url: string }): SourceSidebarItem {
  const ghHandle = source.type === "github" ? githubRepoHandle(source.url) : null;
  if (ghHandle) {
    return {
      label: "Source",
      value: (
        <span className="inline-flex items-center gap-1.5">
          <SourceTypeIcon type="github" size={13} />
          <span>{ghHandle}</span>
        </span>
      ),
      externalLink: source.url,
    };
  }
  return { label: "Source", value: shortUrl(source.url), externalLink: source.url };
}
