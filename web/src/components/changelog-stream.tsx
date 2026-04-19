"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { markdownComponents } from "./markdown-components";
import type { SourceChangelogResponse } from "@/lib/api";

interface InitialSlice {
  content: ReactNode;
  offset: number;
  limit: number;
  nextOffset: number | null;
  totalChars: number;
}

interface ChangelogStreamProps {
  slug: string;
  markdownClassName: string;
  initial: InitialSlice;
  /** Active file path for multi-file sources; threaded into lazy-load fetches. */
  activePath?: string;
}

interface Chunk {
  id: number;
  content: string;
}

export function ChangelogStream({
  slug,
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
        `/api/sources/${encodeURIComponent(slug)}/changelog?${params.toString()}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SourceChangelogResponse = await res.json();
      nextChunkId.current += 1;
      setChunks((prev) => [...prev, { id: nextChunkId.current, content: data.content }]);
      setLoadedChars((prev) => prev + data.content.length);
      setNextOffset(data.nextOffset);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoading(false);
    }
  }, [loading, nextOffset, slug, initial.limit, activePath]);

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
      <div className={markdownClassName}>{initial.content}</div>
      {chunks.map((chunk) => (
        <div key={chunk.id} className={markdownClassName}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeShikiPlugin]}
            components={markdownComponents}
          >
            {chunk.content}
          </ReactMarkdown>
        </div>
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
