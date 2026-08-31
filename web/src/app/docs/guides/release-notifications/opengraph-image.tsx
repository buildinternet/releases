import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og";

export const alt = "How to get notified when products ship updates";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const dynamic = "force-static";

export default function Image() {
  return renderOgImage({
    eyebrow: "Guide",
    title: "Get notified when products ship updates",
    subtitle: "Slack, Discord, email digests, RSS, and signed webhooks",
    description:
      "Every way to have changelog updates come to you — from a feed reader to a webhook into your own systems.",
  });
}
