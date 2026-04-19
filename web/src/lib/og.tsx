import { ImageResponse } from "next/og";
import { clamp, isHeroImageResponse, isJunkMediaUrl } from "./og-helpers";

export { formatCount, formatDate, stripMarkdown } from "./og-helpers";

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = "image/png" as const;

export type OgMetric = { label: string; value: string };

export type OgTemplateProps = {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  description?: string;
  metrics?: OgMetric[];
  avatarUrl?: string | null;
  heroImage?: string | null;
};

type MediaLike = {
  type?: string | null;
  url?: string | null;
  r2Url?: string | null;
};

type OrgAvatarShape =
  | {
      avatarUrl?: string | null;
      accounts?: Array<{ platform: string; handle: string }>;
    }
  | null
  | undefined;

function clampProps(props: OgTemplateProps) {
  return {
    title: clamp(props.title, 96),
    subtitle: props.subtitle ? clamp(props.subtitle, 120) : null,
    description: props.description ? clamp(props.description, 180) : null,
    metrics: props.metrics ?? [],
  };
}

function titleFontSize(length: number, hasHero: boolean): number {
  if (hasHero) {
    if (length <= 22) return 88;
    if (length <= 36) return 72;
    if (length <= 56) return 60;
    return 48;
  }
  if (length <= 22) return 112;
  if (length <= 36) return 88;
  if (length <= 56) return 68;
  return 52;
}

const BG_BASE = "#0c0a09";
const BG_RADIAL =
  "radial-gradient(circle at 90% 10%, rgba(120,113,108,0.12), transparent 55%), radial-gradient(circle at 10% 90%, rgba(68,64,60,0.18), transparent 50%)";

function BrandBar({ avatarUrl, bleed }: { avatarUrl?: string | null; bleed?: boolean }) {
  const borderColor = bleed ? "rgba(255,255,255,0.2)" : "#44403c";
  const pillColor = bleed ? "#e7e5e4" : "#a8a29e";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
        <div
          style={{
            fontSize: "30px",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: "#fafaf9",
          }}
        >
          releases.sh
        </div>
        <div
          style={{
            display: "flex",
            fontSize: "12px",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            color: pillColor,
            border: `1px solid ${borderColor}`,
            borderRadius: "4px",
            padding: "5px 9px",
            lineHeight: 1,
          }}
        >
          preview
        </div>
      </div>
      {avatarUrl ? (
        <div style={{ display: "flex", alignItems: "center" }}>
          <img
            src={avatarUrl}
            width={64}
            height={64}
            style={{
              borderRadius: "50%",
              border: `1px solid ${borderColor}`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function MetricRow({ metrics, bleed }: { metrics: OgMetric[]; bleed?: boolean }) {
  const valueColor = "#fafaf9";
  const labelColor = bleed ? "#a8a29e" : "#78716c";
  const borderColor = bleed ? "rgba(255,255,255,0.12)" : "#292524";
  return (
    <div
      style={{
        display: "flex",
        gap: "56px",
        alignItems: "flex-end",
        borderTop: `1px solid ${borderColor}`,
        paddingTop: "28px",
      }}
    >
      {metrics.map((m) => (
        <div key={m.label} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div
            style={{
              fontSize: "34px",
              fontWeight: 700,
              color: valueColor,
              letterSpacing: "-0.02em",
              lineHeight: 1,
            }}
          >
            {m.value}
          </div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: labelColor,
            }}
          >
            {m.label}
          </div>
        </div>
      ))}
    </div>
  );
}

function Headline({
  eyebrow,
  title,
  subtitle,
  description,
  maxTitleSize,
  colors,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  maxTitleSize: number;
  colors: { eyebrow: string; title: string; subtitle: string; description: string };
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {eyebrow ? (
        <div
          style={{
            fontSize: "18px",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.14em",
            color: colors.eyebrow,
          }}
        >
          {eyebrow}
        </div>
      ) : null}
      <div
        style={{
          fontSize: `${maxTitleSize}px`,
          fontWeight: 700,
          lineHeight: 1.05,
          letterSpacing: "-0.03em",
          color: colors.title,
        }}
      >
        {title}
      </div>
      {subtitle ? (
        <div
          style={{
            fontSize: "30px",
            fontWeight: 500,
            color: colors.subtitle,
            lineHeight: 1.3,
          }}
        >
          {subtitle}
        </div>
      ) : null}
      {description ? (
        <div
          style={{
            fontSize: "22px",
            color: colors.description,
            lineHeight: 1.4,
            marginTop: "4px",
          }}
        >
          {description}
        </div>
      ) : null}
    </div>
  );
}

function renderOgImageText(props: OgTemplateProps): ImageResponse {
  const { title, subtitle, description, metrics } = clampProps(props);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: BG_BASE,
          color: "#f5f5f4",
          padding: "72px",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          backgroundImage: BG_RADIAL,
        }}
      >
        <BrandBar avatarUrl={props.avatarUrl} />
        <Headline
          eyebrow={props.eyebrow}
          title={title}
          subtitle={subtitle}
          description={description}
          maxTitleSize={titleFontSize(title.length, false)}
          colors={{
            eyebrow: "#a8a29e",
            title: "#fafaf9",
            subtitle: "#d6d3d1",
            description: "#a8a29e",
          }}
        />
        {metrics.length > 0 ? (
          <MetricRow metrics={metrics} />
        ) : (
          <div
            style={{
              display: "flex",
              borderTop: "1px solid #292524",
              paddingTop: "28px",
              fontSize: "18px",
              color: "#78716c",
              letterSpacing: "0.02em",
            }}
          >
            An agent-friendly API for product changelogs
          </div>
        )}
      </div>
    ),
    { ...OG_SIZE },
  );
}

function renderOgImageBleed(props: OgTemplateProps): ImageResponse {
  const { title, subtitle, description, metrics } = clampProps(props);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          backgroundColor: BG_BASE,
          color: "#f5f5f4",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        <img
          src={props.heroImage!}
          style={{
            position: "absolute",
            width: "100%",
            height: "100%",
            top: 0,
            left: 0,
            objectFit: "cover",
            opacity: 0.55,
            filter: "blur(22px) saturate(1.1)",
            transform: "scale(1.1)",
          }}
        />
        <div
          style={{
            position: "absolute",
            width: "100%",
            height: "100%",
            top: 0,
            left: 0,
            backgroundImage:
              "linear-gradient(135deg, rgba(12,10,9,0.88) 0%, rgba(12,10,9,0.6) 60%, rgba(12,10,9,0.4) 100%)",
            display: "flex",
          }}
        />
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: "72px",
          }}
        >
          <BrandBar avatarUrl={props.avatarUrl} bleed />
          <Headline
            eyebrow={props.eyebrow}
            title={title}
            subtitle={subtitle}
            description={description}
            maxTitleSize={titleFontSize(title.length, false)}
            colors={{
              eyebrow: "#d6d3d1",
              title: "#fafaf9",
              subtitle: "#e7e5e4",
              description: "#d6d3d1",
            }}
          />
          {metrics.length > 0 ? (
            <MetricRow metrics={metrics} bleed />
          ) : (
            <div style={{ display: "flex" }} />
          )}
        </div>
      </div>
    ),
    { ...OG_SIZE },
  );
}

/**
 * Split layout: text left (60%), hero right (40%). Not wired into any route yet;
 * kept as a ready-to-use template for future variants (e.g., richer release
 * cards where the hero is self-contained and shouldn't bleed behind text).
 */
export function renderOgImageSplit(props: OgTemplateProps): ImageResponse {
  const { title, subtitle, description, metrics } = clampProps(props);
  const hero = props.heroImage;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          backgroundColor: BG_BASE,
          color: "#f5f5f4",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            width: hero ? "60%" : "100%",
            padding: "72px",
            backgroundImage: BG_RADIAL,
          }}
        >
          <BrandBar avatarUrl={props.avatarUrl} />
          <Headline
            eyebrow={props.eyebrow}
            title={title}
            subtitle={subtitle}
            description={description}
            maxTitleSize={titleFontSize(title.length, true)}
            colors={{
              eyebrow: "#a8a29e",
              title: "#fafaf9",
              subtitle: "#d6d3d1",
              description: "#a8a29e",
            }}
          />
          {metrics.length > 0 ? (
            <MetricRow metrics={metrics} />
          ) : (
            <div style={{ display: "flex" }} />
          )}
        </div>
        {hero ? (
          <div
            style={{
              display: "flex",
              width: "40%",
              height: "100%",
              backgroundColor: "#1c1917",
            }}
          >
            <img src={hero} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
        ) : null}
      </div>
    ),
    { ...OG_SIZE },
  );
}

export function renderOgImage(props: OgTemplateProps): ImageResponse {
  if (props.heroImage) return renderOgImageBleed(props);
  return renderOgImageText(props);
}

const HERO_FETCH_TIMEOUT_MS = 4_000;
const AVATAR_FETCH_TIMEOUT_MS = 1_500;

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches the first media candidate, validates content-type and size,
 * and returns a base64 data URI so Satori can render without a second
 * network hop. Returns null for non-images, tiny thumbnails (author
 * avatars baked into changelog posts), or anything that fails.
 */
export async function resolveHeroImage(
  media: MediaLike[] | null | undefined,
): Promise<string | null> {
  if (!media || media.length === 0) return null;
  const candidate = media.find((m) => (m.type ?? "image") === "image" && !!(m.r2Url ?? m.url));
  if (!candidate) return null;
  if (isJunkMediaUrl(candidate.url)) return null;

  const fetchUrl = candidate.r2Url ?? candidate.url;
  if (!fetchUrl) return null;

  const res = await fetchWithTimeout(fetchUrl, HERO_FETCH_TIMEOUT_MS, { redirect: "follow" });
  if (!res || !res.ok) return null;

  const ctype = res.headers.get("content-type") ?? "";
  try {
    const buf = await res.arrayBuffer();
    if (!isHeroImageResponse(ctype, buf.byteLength)) return null;
    const b64 = Buffer.from(buf).toString("base64");
    const normalizedType = ctype.split(";")[0].trim().toLowerCase();
    return `data:${normalizedType};base64,${b64}`;
  } catch {
    return null;
  }
}

export async function resolveAvatarUrl(org: OrgAvatarShape): Promise<string | null> {
  if (!org) return null;
  if (org.avatarUrl) return org.avatarUrl;
  const githubHandle = org.accounts?.find((a) => a.platform === "github")?.handle;
  if (!githubHandle) return null;

  const url = `https://github.com/${encodeURIComponent(githubHandle)}.png?size=200`;
  const res = await fetchWithTimeout(url, AVATAR_FETCH_TIMEOUT_MS, {
    method: "HEAD",
    redirect: "follow",
  });
  if (!res || !res.ok) return null;
  return res.url || url;
}

export function renderOgFallback(): ImageResponse {
  return renderOgImage({
    title: "releases.sh",
    subtitle: "An agent-friendly API for product changelogs",
  });
}
