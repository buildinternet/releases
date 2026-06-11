import type {
  StoredSiteNotice,
  SiteNoticePlacement,
} from "@buildinternet/releases-core/site-notice";
import { api } from "./api";

/**
 * Read the current public site notice, failing OPEN: any error (API down, 404,
 * malformed) yields null so a banner hiccup never breaks a page render. Cached
 * by the underlying `fetchApi` (~60s ISR), so a published change appears within
 * about a minute.
 */
export async function getSiteNotice(): Promise<StoredSiteNotice | null> {
  try {
    const { notice } = await api.siteNotice();
    return notice;
  } catch {
    return null;
  }
}

/**
 * Pure gate: return the notice only when it is active and its placement matches
 * the render slot (slot values equal placement values). Drives both mount points.
 */
export function selectNoticeForSlot(
  notice: StoredSiteNotice | null,
  slot: SiteNoticePlacement,
): StoredSiteNotice | null {
  if (!notice || !notice.active) return null;
  return notice.placement === slot ? notice : null;
}
