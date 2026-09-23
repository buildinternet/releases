"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Shape returned by the `/api/orgs/[org]/sources/[source]/changelog` route
 * handler: a slice pre-rendered to HTML server-side (`contentHtml`), plus the
 * `nextOffset` cursor. The raw `content` markdown no longer rides the wire —
 * rendering happens on the server so shiki + react-markdown stay out of this
 * client bundle (#1919).
 */
interface ChangelogChunkResponse {
  contentHtml: string;
  nextOffset: number | null;
}

interface InitialSlice {
  /** The initial slice already rendered to sanitized HTML on the server. */
  contentHtml: string;
  offset: number;
  limit: number;
  nextOffset: number | null;
  totalChars: number;
}

interface ChangelogStreamProps {
  orgSlug: string;
  sourceSlug: string;
  markdownClassName: string;
  initial: InitialSlice;
  /** Active file path for multi-file sources; threaded into lazy-load fetches. */
  activePath?: string;
}

interface Chunk {
  id: number;
  /** Server-rendered, sanitized HTML for this lazily-loaded slice. */
  contentHtml: string;
}

export function ChangelogStream({
  orgSlug,
  sourceSlug,
  markdownClassName,
  initial,
  activePath,
}: ChangelogStreamProps) {
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(initial.nextOffset);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedChars, setLoadedChars] = useState(initial.nextOffset ?? initial.totalChars);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const nextChunkId = useRef(0);

  const loadNext = useCallback(async () => {
    if (loading || nextOffset == null) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("offset", String(nextOffset));
      params.set("limit", String(initial.limit));
      if (activePath) params.set("path", activePath);
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgSlug)}/sources/${encodeURIComponent(sourceSlug)}/changelog?${params.toString()}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ChangelogChunkResponse = await res.json();
      nextChunkId.current += 1;
      setChunks((prev) => [...prev, { id: nextChunkId.current, contentHtml: data.contentHtml }]);
      // `nextOffset` is the authoritative char cursor into the full file, so it
      // doubles as "chars loaded so far" for the progress readout — no need to
      // ship the raw slice back just to measure its length.
      setLoadedChars(data.nextOffset ?? initial.totalChars);
      setNextOffset(data.nextOffset);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoading(false);
    }
  }, [loading, nextOffset, orgSlug, sourceSlug, initial.limit, initial.totalChars, activePath]);

  useEffect(() => {
    if (nextOffset == null) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadNext();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [nextOffset, loadNext]);

  return (
    <>
      {/* Both the initial slice and every lazily-loaded chunk arrive as HTML
          already rendered (and sanitized — no `allowDangerousHtml`) by the
          shared server pipeline, so shiki + react-markdown never load here. */}
      <div
        className={markdownClassName}
        dangerouslySetInnerHTML={{ __html: initial.contentHtml }}
      />
      {chunks.map((chunk) => (
        <div
          key={chunk.id}
          className={markdownClassName}
          dangerouslySetInnerHTML={{ __html: chunk.contentHtml }}
        />
      ))}
      {nextOffset != null && (
        <div
          ref={sentinelRef}
          className="mt-6 flex items-center justify-center py-3 text-[12px] text-stone-400 dark:text-stone-500"
        >
          {error ? (
            <button
              onClick={() => void loadNext()}
              className="text-stone-500 dark:text-stone-400 underline"
            >
              Retry loading changelog
            </button>
          ) : loading ? (
            <span>Loading more…</span>
          ) : (
            <span>
              {Math.round((loadedChars / initial.totalChars) * 100)}% loaded — scroll for more
            </span>
          )}
        </div>
      )}
    </>
  );
}
