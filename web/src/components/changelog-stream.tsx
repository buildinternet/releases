"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { markdownComponents } from "./markdown-components";
import type { SourceChangelogResponse } from "@/lib/api";

interface ChangelogStreamProps {
  slug: string;
  markdownClassName: string;
  initial: ReactNode;
  initialNextOffset: number | null;
  totalChars: number;
  initialOffset: number;
  initialLimit: number;
}

interface Chunk {
  id: number;
  content: string;
}

export function ChangelogStream({
  slug,
  markdownClassName,
  initial,
  initialNextOffset,
  totalChars,
  initialOffset,
  initialLimit,
}: ChangelogStreamProps) {
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(initialNextOffset);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadedChars = chunks.reduce(
    (n, c) => n + c.content.length,
    (initialOffset === 0 ? initialLimit : 0),
  );
  const nextChunkId = useRef(0);

  const loadNext = useCallback(async () => {
    if (loading || nextOffset == null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/sources/${encodeURIComponent(slug)}/changelog?offset=${nextOffset}&limit=${initialLimit}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SourceChangelogResponse = await res.json();
      nextChunkId.current += 1;
      setChunks((prev) => [...prev, { id: nextChunkId.current, content: data.content }]);
      setNextOffset(data.nextOffset);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoading(false);
    }
  }, [loading, nextOffset, slug, initialLimit]);

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
      <div className={markdownClassName}>{initial}</div>
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
        <div ref={sentinelRef} className="mt-6 flex items-center justify-center py-3 text-[12px] text-stone-400 dark:text-stone-500">
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
              {Math.round((loadedChars / totalChars) * 100)}% loaded — scroll for more
            </span>
          )}
        </div>
      )}
    </>
  );
}
