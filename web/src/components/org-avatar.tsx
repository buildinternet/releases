import Image from "next/image";
import { isOptimizableImage } from "@/lib/sanitize";

interface OrgAvatarProps {
  avatarUrl: string | null;
  githubHandle: string | null;
  name: string;
  size?: number;
}

export function OrgAvatar({ avatarUrl, githubHandle, name, size = 24 }: OrgAvatarProps) {
  const src =
    avatarUrl ?? (githubHandle ? `https://github.com/${githubHandle}.png?size=${size * 2}` : null);

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
