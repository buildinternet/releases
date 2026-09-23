import type { ReactNode } from "react";

/** Compact relative age for status hints (e.g. "3d ago", "just now"). */
export function formatAdminAge(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatAdminAbsolute(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

/**
 * Status line under a setting — current state / last-run facts, not the impact
 * of the control (that belongs in the byline).
 */
export function StatusHint({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1.5 text-[12px] leading-relaxed text-stone-500 dark:text-stone-400">
      <span className="font-medium text-stone-600 dark:text-stone-300">Status · </span>
      {children}
    </p>
  );
}

export const CADENCE_MIN = 1;
export const CADENCE_MAX = 90;
export const CADENCE_DEFAULT_HINT = 7;

export function clampCadenceDays(n: number): number {
  if (!Number.isFinite(n)) return CADENCE_DEFAULT_HINT;
  return Math.min(CADENCE_MAX, Math.max(CADENCE_MIN, Math.round(n)));
}
