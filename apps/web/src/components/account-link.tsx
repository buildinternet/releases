const GITHUB_PATH =
  "M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z";

const X_PATH =
  "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";

const YOUTUBE_PATH =
  "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z";

const BLUESKY_PATH =
  "M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026";

interface AccountIconProps {
  platform: string;
  size?: number;
  className?: string;
}

export function AccountIcon({ platform, size = 13, className }: AccountIconProps) {
  const path = iconPath(platform);
  if (!path) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      role="img"
      aria-hidden="true"
      className={className}
    >
      <path d={path} />
    </svg>
  );
}

function iconPath(platform: string): string | null {
  switch (platform) {
    case "github":
      return GITHUB_PATH;
    case "x":
      return X_PATH;
    case "youtube":
      return YOUTUBE_PATH;
    case "bluesky":
      return BLUESKY_PATH;
    default:
      return null;
  }
}

export function accountUrl(platform: string, handle: string): string | null {
  const h = handle.trim();
  if (!h) return null;
  switch (platform) {
    case "github":
      return `https://github.com/${h}`;
    case "x":
      return `https://x.com/${h}`;
    case "youtube":
      // Stored as `@channel`, `/c/foo`, `/user/foo`, `/channel/UC…`, or bare.
      if (h.startsWith("/")) return `https://www.youtube.com${h}`;
      if (h.startsWith("@")) return `https://www.youtube.com/${h}`;
      return `https://www.youtube.com/@${h}`;
    case "bluesky":
      // Handles are domains (`vitest.dev`) or `name.bsky.social`; stored bare, no `@`.
      return `https://bsky.app/profile/${h.replace(/^@/, "")}`;
    default:
      return null;
  }
}

export function formatAccountHandle(platform: string, handle: string): string {
  const h = handle.trim();
  if (platform === "x") return h.startsWith("@") ? h : `@${h}`;
  if (platform === "youtube") {
    if (h.startsWith("/c/") || h.startsWith("/user/") || h.startsWith("/channel/")) {
      return h.replace(/^\/(c|user|channel)\//, "");
    }
    return h.startsWith("@") ? h : `@${h}`;
  }
  return h;
}

interface AccountLinkProps {
  platform: string;
  handle: string;
  size?: number;
}

export function AccountLink({ platform, handle, size = 13 }: AccountLinkProps) {
  const url = accountUrl(platform, handle);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer me"
      className="flex items-center gap-1.5 text-[13px] text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
    >
      <AccountIcon platform={platform} size={size} className="shrink-0" />
      <span className="truncate">{formatAccountHandle(platform, handle)}</span>
    </a>
  );
}
