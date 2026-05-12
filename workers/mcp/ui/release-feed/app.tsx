/**
 * Release-feed MCP App UI.
 *
 * Renders the structured payload returned by `get_latest_releases` /
 * `get_collection_releases` as a card timeline. Supports cursor pagination
 * by calling the same tool again through the host — no host re-prompt needed.
 *
 * The model still sees the markdown text fallback returned in `content[0].text`;
 * this UI consumes `structuredContent` for richer rendering.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

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
  source: { name: string; coordinate: string };
}

interface FeedPayload {
  releases: ReleaseRow[];
  pagination: { kind: "cursor"; hasMore: boolean; nextCursor: string | null; returned: number };
  inputs: Record<string, unknown>;
  toolName: "get_latest_releases" | "get_collection_releases";
  context?: { collection?: { slug: string; name: string } };
}

function extractStructured(result: CallToolResult): FeedPayload | null {
  const sc = result.structuredContent as unknown;
  if (!sc || typeof sc !== "object") return null;
  if (!("releases" in sc) || !Array.isArray((sc as { releases: unknown }).releases)) return null;
  return sc as FeedPayload;
}

function formatDate(iso: string | null): string {
  if (!iso) return "Date unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 1) return "Today";
  if (diffDays < 2) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function pickTitle(r: ReleaseRow): string {
  return r.titleShort || r.titleGenerated || r.title || r.version || "Untitled release";
}

interface ReleaseCardProps {
  release: ReleaseRow;
  onOpenLink: (url: string) => void;
  onAskMore: (release: ReleaseRow) => void;
}

function ReleaseCard({ release, onOpenLink, onAskMore }: ReleaseCardProps) {
  const title = pickTitle(release);
  const body = release.summary || release.contentPreview;
  return (
    <article className="card">
      <header className="card-head">
        <div className="card-meta">
          <span className="source">{release.source.coordinate}</span>
          {release.type === "rollup" && <span className="chip chip-rollup">Rollup</span>}
          <time className="date" dateTime={release.publishedAt ?? undefined}>
            {formatDate(release.publishedAt)}
          </time>
        </div>
        <h2 className="card-title">{title}</h2>
        {release.version && release.version !== title && (
          <div className="version">
            <span className="chip chip-version">{release.version}</span>
          </div>
        )}
      </header>
      {body && <p className="card-body">{body}</p>}
      <footer className="card-foot">
        {release.url && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onOpenLink(release.url!)}
          >
            Open source
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={() => onAskMore(release)}>
          Ask about this
        </button>
      </footer>
    </article>
  );
}

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

  const header = useMemo(() => {
    if (initial.context?.collection) {
      return { title: initial.context.collection.name, sub: "Collection feed" };
    }
    const inputs = initial.inputs as { organization?: string; product?: string };
    if (inputs.product) return { title: inputs.product, sub: "Product releases" };
    if (inputs.organization) return { title: inputs.organization, sub: "Organization releases" };
    return { title: "Latest releases", sub: "Across the registry" };
  }, [initial]);

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

  const handleOpenLink = useCallback(
    async (url: string) => {
      try {
        await app.openLink({ url });
      } catch (e) {
        console.error("openLink failed", e);
      }
    },
    [app],
  );

  const handleAskMore = useCallback(
    async (release: ReleaseRow) => {
      const title = pickTitle(release);
      const text = `Tell me more about the ${release.source.coordinate} release "${title}" (id: ${release.id}). Use the get_release tool to fetch the full content.`;
      try {
        await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
      } catch (e) {
        console.error("sendMessage failed", e);
      }
    },
    [app],
  );

  return (
    <main className="feed">
      <header className="feed-head">
        <p className="feed-sub">{header.sub}</p>
        <h1 className="feed-title">{header.title}</h1>
        <p className="feed-count">
          {releases.length} release{releases.length === 1 ? "" : "s"}
          {hasMore ? " · more available" : ""}
        </p>
      </header>
      <div className="feed-list">
        {releases.map((r) => (
          <ReleaseCard
            key={r.id}
            release={r}
            onOpenLink={handleOpenLink}
            onAskMore={handleAskMore}
          />
        ))}
      </div>
      {error && <div className="error">Failed to load more: {error}</div>}
      {hasMore && (
        <div className="feed-foot">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleLoadMore}
            disabled={loading}
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </main>
  );
}

function FeedApp() {
  const [payload, setPayload] = useState<FeedPayload | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  const { app, error } = useApp({
    appInfo: { name: "Releases Feed", version: "0.1.0" },
    capabilities: {},
    onAppCreated: (created) => {
      created.ontoolresult = (result) => {
        const data = extractStructured(result);
        if (data) {
          setPayload(data);
        } else {
          setUnsupported(true);
        }
      };
      created.onerror = console.error;
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
