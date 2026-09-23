import type { SiteNoticePlacement } from "@buildinternet/releases-core/site-notice";
import { getSiteNotice, selectNoticeForSlot } from "@/lib/site-notice";
import { SiteNoticeView } from "./site-notice-view";

/**
 * Server wrapper mounted in two places: the root layout (`slot="banner"`) and
 * the home page (`slot="home"`). Fetches the current notice (fail-open) and
 * renders the view only when the notice's placement matches this slot.
 */
export async function SiteNotice({ slot }: { slot: SiteNoticePlacement }) {
  const notice = selectNoticeForSlot(await getSiteNotice(), slot);
  if (!notice) return null;
  return <SiteNoticeView notice={notice} variant={slot === "banner" ? "banner" : "card"} />;
}
