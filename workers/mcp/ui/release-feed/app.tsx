/**
 * Release-feed MCP App UI.
 *
 * Renders the structured payload from `get_latest_releases` /
 * `get_collection_releases` as a fixed-height, internally-scrolling feed
 * (master view) and supports drilling into a single release (detail view) that
 * lazy-fetches the full body via `get_release` and renders it as markdown —
 * mirroring the web feed. Cursor pagination re-calls the same tool through the
 * host; the model still sees the markdown text fallback in `content[0].text`.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown, { type Components } from "react-markdown";
import { createRemarkPlugins, githubRepoUrlFor } from "@releases/rendering/markdown-plugins";

/** Org identity used to render the company icon + human-readable label. */
interface OrgIdentity {
  name: string;
  slug: string;
  avatarUrl: string | null;
  githubHandle: string | null;
}

interface ReleaseRow {
  id: string;
  title: string | null;
  titleShort: string | null;
  titleGenerated: string | null;
  version: string | null;
  type: "feature" | "rollup";
  summary: string | null;
  contentPreview: string;
  publishedAt: string | null;
  url: string | null;
  source: { name: string; coordinate: string; type: string };
  org: OrgIdentity | null;
  product: { name: string; slug: string } | null;
}

interface FeedPayload {
  releases: ReleaseRow[];
  pagination: { kind: "cursor"; hasMore: boolean; nextCursor: string | null; returned: number };
  inputs: Record<string, unknown>;
  toolName: "get_latest_releases" | "get_collection_releases";
  context?: { collection?: { slug: string; name: string } };
}

interface ReleaseDetail {
  id: string;
  title: string | null;
  titleShort: string | null;
  titleGenerated: string | null;
  version: string | null;
  type: "feature" | "rollup";
  content: string;
  summary: string | null;
  publishedAt: string | null;
  url: string | null;
  source: { name: string; coordinate: string; type: string };
  org: OrgIdentity | null;
  product: { name: string; slug: string } | null;
}

function extractStructured(result: CallToolResult): FeedPayload | null {
  const sc = result.structuredContent as unknown;
  if (!sc || typeof sc !== "object") return null;
  if (!("releases" in sc) || !Array.isArray((sc as { releases: unknown }).releases)) return null;
  return sc as FeedPayload;
}

function extractDetail(result: CallToolResult): ReleaseDetail | null {
  const sc = result.structuredContent as unknown;
  if (!sc || typeof sc !== "object") return null;
  if (!("content" in sc) || !("source" in sc)) return null;
  return sc as ReleaseDetail;
}

function formatDate(iso: string | null): string {
  if (!iso) return "Date unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 1) return "Today";
  if (diffDays < 2) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function pickTitle(r: {
  titleShort: string | null;
  titleGenerated: string | null;
  title: string | null;
  version: string | null;
}): string {
  return r.titleShort || r.titleGenerated || r.title || r.version || "Untitled release";
}

/**
 * Only http(s) URLs may be forwarded to `app.openLink`. Release markdown is
 * untrusted content, so reject `javascript:`, `data:`, relative, and malformed
 * hrefs before handing them to the host.
 */
function isAllowedProtocol(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Collapse markdown to a single line of plain text for the compact list row. */
function stripMarkdown(md: string): string {
  return (
    md
      .replace(/```[\s\S]*?```/g, " ") // fenced code
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → text
      .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
      .replace(/^\s{0,3}>\s?/gm, "") // blockquotes
      .replace(/^\s{0,3}[-*+]\s+/gm, "") // bullet markers
      .replace(/^\s{0,3}\d+\.\s+/gm, "") // ordered markers
      .replace(/`([^`]*)`/g, "$1") // inline code → its contents
      // `_` is not an emphasis marker here: in changelog prose it is far more
      // often an identifier character (`whats_changed`), and unwrapping code
      // spans above exposes those identifiers to this pass.
      .replace(/[*~]/g, "") // emphasis
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Company icon. Mirrors the web `OrgAvatar`: stored avatar first, GitHub-handle
 * PNG as fallback, monogram circle when neither resolves.
 *
 * The host iframe runs under a deny-by-default CSP; we declare our avatar
 * origins via the UI resource's `_meta.ui.csp.resourceDomains` so images load.
 * The `onError` chain is defense-in-depth: if a candidate is still blocked or
 * 404s, we advance to the next source and ultimately the monogram, so a load
 * failure degrades gracefully instead of showing a broken-image placeholder.
 */
function OrgAvatar({ org, size = 18 }: { org: OrgIdentity | null; size?: number }) {
  const candidates = useMemo(() => {
    const list: string[] = [];
    if (org?.avatarUrl) list.push(org.avatarUrl);
    if (org?.githubHandle) list.push(`https://github.com/${org.githubHandle}.png?size=${size * 2}`);
    return list;
  }, [org?.avatarUrl, org?.githubHandle, size]);

  const [failedCount, setFailedCount] = useState(0);
  // Reset the failure cursor when the candidate set changes (row recycling).
  useEffect(() => setFailedCount(0), [candidates]);

  const src = candidates[failedCount] ?? null;
  if (!src) {
    const letter = (org?.name ?? "?").charAt(0).toUpperCase();
    return (
      <span
        className="org-avatar org-avatar-fallback"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
        aria-hidden="true"
      >
        {letter}
      </span>
    );
  }
  return (
    <img
      className="org-avatar"
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      aria-hidden="true"
      onError={() => setFailedCount((n) => n + 1)}
    />
  );
}

interface RowLabel {
  /** Primary identity text. */
  primary: string;
  /** Render `primary` in the mono font (GitHub `org/repo` coordinate). */
  mono: boolean;
  /** Secondary product/source label, shown muted after a separator. */
  secondary: string | null;
}

/**
 * Identity label for a feed row. Matches the web app's preference: GitHub
 * sources show the `org/repo` coordinate (the recognizable handle); everything
 * else favors human-readable display names. In a cross-org feed we lead with
 * the org; in a single-org feed the org sits in the header, so rows lead with
 * the product/source instead.
 */
function rowLabel(
  r: Pick<ReleaseRow, "source" | "org" | "product">,
  opts: { crossOrg: boolean },
): RowLabel {
  if (r.source.type === "github") {
    return { primary: r.source.coordinate, mono: true, secondary: null };
  }
  const within = r.product?.name ?? r.source.name;
  if (opts.crossOrg) {
    const primary = r.org?.name ?? r.source.name;
    return { primary, mono: false, secondary: within !== primary ? within : null };
  }
  return { primary: within, mono: false, secondary: null };
}

interface FeedHeader {
  sub: string;
  title: string;
  /** Non-null only for single-org / single-product feeds → drives the header avatar. */
  org: OrgIdentity | null;
}

/**
 * Header copy + whether the feed is org-scoped. A null `org` means a cross-org
 * feed (collection or across-the-registry), which is also what flips rows into
 * org-led mode.
 */
function deriveHeader(payload: FeedPayload, rows: ReleaseRow[]): FeedHeader {
  if (payload.context?.collection) {
    return { sub: "Collection feed", title: payload.context.collection.name, org: null };
  }
  const inputs = payload.inputs as { organization?: string; product?: string };
  const firstOrg = rows[0]?.org ?? null;
  if (inputs.product) {
    return {
      sub: "Product releases",
      title: rows[0]?.product?.name ?? inputs.product,
      org: firstOrg,
    };
  }
  if (inputs.organization) {
    return {
      sub: "Organization releases",
      title: firstOrg?.name ?? inputs.organization,
      org: firstOrg,
    };
  }
  return { sub: "Across the registry", title: "Latest releases", org: null };
}

function ExternalLinkIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

// ── Day / org grouping (cross-org feeds) ─────────────────────────────────

interface DayBucket {
  key: string;
  iso: string | null;
  rows: ReleaseRow[];
}
interface OrgBucket {
  key: string;
  org: OrgIdentity | null;
  name: string;
  rows: ReleaseRow[];
}

/** Bucket the (already date-sorted) feed into contiguous day runs. */
function groupByDay(rows: ReleaseRow[]): DayBucket[] {
  const out: DayBucket[] = [];
  let cur: DayBucket | null = null;
  for (const r of rows) {
    const key = r.publishedAt ? r.publishedAt.slice(0, 10) : "undated";
    if (!cur || cur.key !== key) {
      cur = { key, iso: r.publishedAt, rows: [] };
      out.push(cur);
    }
    cur.rows.push(r);
  }
  return out;
}

/** Bucket a day's rows by org, preserving first-appearance order. */
function groupByOrg(rows: ReleaseRow[]): OrgBucket[] {
  const map = new Map<string, OrgBucket>();
  for (const r of rows) {
    const key = r.org?.slug || r.source.coordinate;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { key, org: r.org, name: r.org?.name ?? r.source.name, rows: [] };
      map.set(key, bucket);
    }
    bucket.rows.push(r);
  }
  return Array.from(map.values());
}

function fmtDayHeader(iso: string): { weekday: string; date: string } {
  const d = new Date(iso);
  return {
    weekday: d.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }),
    date: d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }),
  };
}

// ── Feed row ─────────────────────────────────────────────────────────────

/**
 * One compact release row, the click target for the detail view. `showDate`
 * is off in grouped mode (the day header carries the date) and on in the flat
 * single-org list.
 */
function FeedRow({
  r,
  label,
  showDate,
  onOpen,
}: {
  r: ReleaseRow;
  label: RowLabel;
  showDate: boolean;
  onOpen: (row: ReleaseRow) => void;
}) {
  const title = pickTitle(r);
  const snippet = stripMarkdown(r.summary || r.contentPreview || "");
  return (
    <li>
      <button type="button" className="row" onClick={() => onOpen(r)}>
        <div className="row-meta">
          <span className={label.mono ? "source" : "source-name"}>{label.primary}</span>
          {label.secondary && <span className="source-sub">{label.secondary}</span>}
          {r.type === "rollup" && <span className="chip chip-rollup">Rollup</span>}
          {showDate && (
            <time className="date" dateTime={r.publishedAt ?? undefined}>
              {formatDate(r.publishedAt)}
            </time>
          )}
        </div>
        <div className="row-title-line">
          <span className="row-title">{title}</span>
          {r.version && r.version !== title && (
            <span className="chip chip-version">{r.version}</span>
          )}
        </div>
        {snippet && <p className="row-snippet">{snippet}</p>}
        <span className="row-chevron" aria-hidden="true">
          ›
        </span>
      </button>
    </li>
  );
}

/** Display label for a grouped row — org sits in the header, so lead with the product/source. */
function withinOrgLabel(r: ReleaseRow): RowLabel {
  return { primary: r.product?.name ?? r.source.name, mono: false, secondary: null };
}

// ── Master view ────────────────────────────────────────────────────────

interface MasterViewProps {
  payload: FeedPayload;
  releases: ReleaseRow[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  scrollTopRef: { current: number };
  onOpen: (row: ReleaseRow) => void;
  onLoadMore: () => void;
}

function MasterView({
  payload,
  releases,
  hasMore,
  loading,
  error,
  scrollTopRef,
  onOpen,
  onLoadMore,
}: MasterViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Restore the scroll position captured before drilling into a release.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollTopRef.current;
  }, [scrollTopRef]);

  const header = useMemo(() => deriveHeader(payload, releases), [payload, releases]);
  // Cross-org feeds (collections, across-the-registry) group by day → org,
  // mirroring the web collection timeline. Single-org/product feeds keep a flat
  // list since the header already names the org.
  const crossOrg = header.org == null;
  const days = useMemo(() => (crossOrg ? groupByDay(releases) : []), [crossOrg, releases]);

  return (
    <div
      className="app-shell"
      ref={scrollRef}
      onScroll={(e) => {
        scrollTopRef.current = (e.currentTarget as HTMLDivElement).scrollTop;
      }}
    >
      <header className="feed-head">
        <p className="feed-sub">{header.sub}</p>
        <div className="feed-title-line">
          {header.org && <OrgAvatar org={header.org} size={26} />}
          <h1 className="feed-title">{header.title}</h1>
        </div>
        <p className="feed-count">
          {releases.length} release{releases.length === 1 ? "" : "s"}
          {hasMore ? " · more available" : ""}
        </p>
      </header>

      {crossOrg ? (
        <div className="feed-days">
          {days.map((day) => {
            const dayLabel = day.iso ? fmtDayHeader(day.iso) : null;
            return (
              <section className="day" key={day.key}>
                <div className="day-head">
                  {dayLabel ? (
                    <>
                      <span className="day-weekday">{dayLabel.weekday}</span>
                      <span className="day-date">{dayLabel.date}</span>
                    </>
                  ) : (
                    <span className="day-date">Undated</span>
                  )}
                  <span className="day-count">{day.rows.length}</span>
                </div>
                {groupByOrg(day.rows).map((g) => (
                  <div className="org-group" key={g.key}>
                    <div className="org-head">
                      <OrgAvatar org={g.org} size={18} />
                      <span className="org-name">{g.name}</span>
                      <span className="org-count">{g.rows.length}</span>
                    </div>
                    <ul className="feed-list">
                      {g.rows.map((r) => (
                        <FeedRow
                          key={r.id}
                          r={r}
                          label={withinOrgLabel(r)}
                          showDate={false}
                          onOpen={onOpen}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      ) : (
        <ul className="feed-list">
          {releases.map((r) => (
            <FeedRow
              key={r.id}
              r={r}
              label={rowLabel(r, { crossOrg: false })}
              showDate
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
      {error && <div className="error">Failed to load more: {error}</div>}
      {hasMore && (
        <div className="feed-foot">
          <button type="button" className="btn btn-primary" onClick={onLoadMore} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Detail view ──────────────────────────────────────────────────────────

interface DetailViewProps {
  app: App;
  row: ReleaseRow;
  /** Where "Back" returns to — collection or feed name, for orientation. */
  backLabel: string;
  loadDetail: (id: string) => Promise<ReleaseDetail>;
  onBack: () => void;
}

function DetailView({ app, row, backLabel, loadDetail, onBack }: DetailViewProps) {
  const [detail, setDetail] = useState<ReleaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchIt = useCallback(() => {
    setError(null);
    setDetail(null);
    loadDetail(row.id)
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [loadDetail, row.id]);

  useEffect(() => {
    fetchIt();
  }, [fetchIt]);

  const title = pickTitle(detail ?? row);
  const version = detail?.version ?? row.version;
  const url = detail?.url ?? row.url;
  const repoUrl = githubRepoUrlFor(url);
  const markdownComponents = useMemo(() => makeMarkdownComponents(app), [app]);
  const remarkPlugins = useMemo(() => createRemarkPlugins({ repoUrl }), [repoUrl]);

  const openLink = useCallback(
    (href: string) => {
      if (!isAllowedProtocol(href)) return;
      app.openLink({ url: href }).catch((e) => console.error("openLink failed", e));
    },
    [app],
  );

  const askMore = useCallback(() => {
    const text = `Tell me more about the ${row.source.coordinate} release "${title}" (id: ${row.id}). Use the get_release tool if you need the full content.`;
    app
      .sendMessage({ role: "user", content: [{ type: "text", text }] })
      .catch((e) => console.error("sendMessage failed", e));
  }, [app, row, title]);

  const byline = rowLabel(detail ?? row, { crossOrg: true });
  const bylineOrg = (detail ?? row).org;

  return (
    <div className="app-shell">
      <div className="detail">
        <header className="detail-head">
          <div className="detail-head-top">
            <button type="button" className="back" onClick={onBack}>
              ‹ Back to {backLabel}
            </button>
            {url && (
              <button
                type="button"
                className="header-action"
                onClick={() => openLink(url)}
                title="Open the original source"
              >
                View source
                <ExternalLinkIcon size={12} />
              </button>
            )}
          </div>
          <div className="row-meta">
            <OrgAvatar org={bylineOrg} size={16} />
            <span className={byline.mono ? "source" : "source-name"}>{byline.primary}</span>
            {byline.secondary && <span className="source-sub">{byline.secondary}</span>}
            {(detail?.type ?? row.type) === "rollup" && (
              <span className="chip chip-rollup">Rollup</span>
            )}
            <time className="date" dateTime={row.publishedAt ?? undefined}>
              {formatDate(detail?.publishedAt ?? row.publishedAt)}
            </time>
          </div>
          <h1 className="detail-title">{title}</h1>
          {version && version !== title && (
            <div>
              <span className="chip chip-version">{version}</span>
            </div>
          )}
        </header>

        {!detail && !error && <div className="status">Loading release…</div>}
        {error && (
          <div className="detail-error">
            <p className="error">Couldn’t load the full release: {error}</p>
            <div className="detail-actions">
              <button type="button" className="btn btn-secondary" onClick={fetchIt}>
                Retry
              </button>
            </div>
          </div>
        )}
        {detail && (
          <div className="md">
            <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
              {detail.content || detail.summary || "_No content available._"}
            </ReactMarkdown>
          </div>
        )}

        <footer className="detail-foot">
          <button type="button" className="btn btn-secondary" onClick={askMore}>
            Ask about this
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Markdown renderer overrides: route links through the host, cap image height. */
function makeMarkdownComponents(app: App): Components {
  return {
    a({ href, children }) {
      return (
        <a
          href={href ?? "#"}
          onClick={(e) => {
            e.preventDefault();
            if (href && isAllowedProtocol(href)) {
              app.openLink({ url: href }).catch((err) => console.error("openLink", err));
            }
          }}
        >
          {children}
        </a>
      );
    },
    img({ src, alt }) {
      if (!src || typeof src !== "string") return null;
      return <img className="md-img" src={src} alt={alt ?? ""} loading="lazy" />;
    },
  };
}

// ── App shell ──────────────────────────────────────────────────────────

type View = { kind: "list" } | { kind: "detail"; row: ReleaseRow };

interface FeedAppInnerProps {
  app: App;
  initial: FeedPayload;
}

function FeedAppInner({ app, initial }: FeedAppInnerProps) {
  const [releases, setReleases] = useState<ReleaseRow[]>(initial.releases);
  const [nextCursor, setNextCursor] = useState<string | null>(initial.pagination.nextCursor);
  const [hasMore, setHasMore] = useState<boolean>(initial.pagination.hasMore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });

  const listScrollTop = useRef(0);
  const detailCache = useRef(new Map<string, ReleaseDetail>());

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const args = { ...initial.inputs, cursor: nextCursor };
      const result = await app.callServerTool({ name: initial.toolName, arguments: args });
      const payload = extractStructured(result);
      if (!payload) throw new Error("Server returned no structured content");
      setReleases((prev) => [...prev, ...payload.releases]);
      setNextCursor(payload.pagination.nextCursor);
      setHasMore(payload.pagination.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [app, initial, nextCursor, loading]);

  const loadDetail = useCallback(
    async (id: string): Promise<ReleaseDetail> => {
      const cached = detailCache.current.get(id);
      if (cached) return cached;
      const result = await app.callServerTool({ name: "get_release", arguments: { id } });
      const detail = extractDetail(result);
      if (!detail) throw new Error("Release detail was unavailable");
      detailCache.current.set(id, detail);
      return detail;
    },
    [app],
  );

  if (view.kind === "detail") {
    return (
      <main className="feed">
        <DetailView
          app={app}
          row={view.row}
          backLabel={deriveHeader(initial, releases).title}
          loadDetail={loadDetail}
          onBack={() => setView({ kind: "list" })}
        />
      </main>
    );
  }

  return (
    <main className="feed">
      <MasterView
        payload={initial}
        releases={releases}
        hasMore={hasMore}
        loading={loading}
        error={error}
        scrollTopRef={listScrollTop}
        onOpen={(row) => setView({ kind: "detail", row })}
        onLoadMore={handleLoadMore}
      />
    </main>
  );
}

function FeedApp() {
  const [payload, setPayload] = useState<FeedPayload | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  const { app, error } = useApp({
    appInfo: { name: "Releases Feed", version: "0.4.1" },
    capabilities: {},
    onAppCreated: (created) => {
      created.ontoolresult = (result) => {
        const data = extractStructured(result);
        if (data) setPayload(data);
        else setUnsupported(true);
      };
      // oxlint-disable-next-line prefer-add-event-listener -- MCP Apps SDK uses on* property assignment, not EventTarget
      created.onerror = (err) => {
        console.error(err);
      };
      created.onteardown = async () => ({});
    },
  });

  if (error) return <div className="status error">Connect error: {error.message}</div>;
  if (!app) return <div className="status">Connecting…</div>;
  if (unsupported)
    return (
      <div className="status">
        This tool result has no structured release data. The model can still read the text response.
      </div>
    );
  if (!payload) return <div className="status">Waiting for tool result…</div>;
  return <FeedAppInner app={app} initial={payload} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FeedApp />
  </StrictMode>,
);
