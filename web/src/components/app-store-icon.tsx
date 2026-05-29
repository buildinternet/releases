import { FallbackImage } from "./fallback-image";
import { appStoreIconUrl } from "@/lib/app-source";

/**
 * Compact App Store app icon: the resized mzstatic artwork, or a rounded
 * letter tile when the source has no icon. Shared by the org feed rollup
 * header, the search-results card, and the homepage ticker so the small
 * (≤20px) app-icon treatment stays uniform. The 36px feed/detail variant in
 * `release-item.tsx` predates this and renders its own icon inline. #1206
 */
export function AppStoreIcon({
  iconUrl,
  appName,
  size = 20,
  className = "",
}: {
  iconUrl: string | null;
  appName: string;
  size?: number;
  className?: string;
}) {
  if (iconUrl) {
    return (
      <FallbackImage
        src={appStoreIconUrl(iconUrl, 48)}
        alt=""
        width={size}
        height={size}
        className={`rounded-[5px] border border-stone-200 dark:border-stone-800 shrink-0 ${className}`}
      />
    );
  }
  return (
    <div
      style={{ width: size, height: size }}
      className={`flex items-center justify-center rounded-[5px] bg-stone-200 text-[10px] font-semibold text-stone-500 shrink-0 dark:bg-stone-700 dark:text-stone-300 ${className}`}
    >
      {appName.charAt(0)}
    </div>
  );
}
