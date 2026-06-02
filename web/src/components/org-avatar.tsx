import Image from "next/image";
import { isOptimizableImage } from "@/lib/sanitize";

interface OrgAvatarProps {
  avatarUrl: string | null;
  githubHandle: string | null;
  name: string;
  size?: number;
}

/**
 * Resolve an org's avatar image URL: the explicit avatar, else a GitHub avatar
 * from the handle (requested at 2× the render size for crispness), else null.
 * Shared so callers that pre-resolve (e.g. threading a single URL through props)
 * stay in sync with {@link OrgAvatar}'s own fallback.
 */
export function orgAvatarSrc(
  avatarUrl: string | null,
  githubHandle: string | null,
  size = 24,
): string | null {
  return (
    avatarUrl ?? (githubHandle ? `https://github.com/${githubHandle}.png?size=${size * 2}` : null)
  );
}

export function OrgAvatar({ avatarUrl, githubHandle, name, size = 24 }: OrgAvatarProps) {
  const src = orgAvatarSrc(avatarUrl, githubHandle, size);

  if (!src) {
    return (
      <div
        className="rounded-full bg-stone-200 dark:bg-stone-700 flex items-center justify-center text-stone-500 dark:text-stone-400 font-medium shrink-0"
        style={{ width: size, height: size, fontSize: size * 0.4 }}
      >
        {name.charAt(0).toUpperCase()}
      </div>
    );
  }

  return (
    <Image
      src={src}
      alt={name}
      width={size}
      height={size}
      className="rounded-full shrink-0"
      unoptimized={!isOptimizableImage(src)}
    />
  );
}
