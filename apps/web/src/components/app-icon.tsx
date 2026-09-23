import Image from "next/image";
import { isOptimizableImage } from "@/lib/sanitize";

interface AppIconProps {
  iconUrl: string | null;
  name: string;
  size?: number;
}

/**
 * App-store icon: a rounded-square thumbnail (app-icon convention),
 * deliberately distinct from the circular OrgAvatar. Falls back to the first
 * letter on a muted tile when no icon URL is present.
 */
export function AppIcon({ iconUrl, name, size = 24 }: AppIconProps) {
  if (!iconUrl) {
    return (
      <div
        className="rounded-md bg-stone-200 dark:bg-stone-700 flex items-center justify-center text-stone-500 dark:text-stone-400 font-medium shrink-0"
        style={{ width: size, height: size, fontSize: size * 0.4 }}
      >
        {name.charAt(0).toUpperCase()}
      </div>
    );
  }

  return (
    <Image
      src={iconUrl}
      alt={`${name} app icon`}
      width={size}
      height={size}
      className="rounded-md outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10 shrink-0"
      unoptimized={!isOptimizableImage(iconUrl)}
    />
  );
}
