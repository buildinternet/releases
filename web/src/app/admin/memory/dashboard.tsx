"use client";

import { useCallback, useEffect, useState } from "react";

interface Store {
  id: string;
  name: string;
  description: string | null;
  archived_at: string | null;
  created_at?: string;
  memory_count?: number;
  total_bytes?: number;
}

interface MemoryListItem {
  id?: string;
  type: "memory" | "prefix";
  path: string;
  size_bytes?: number;
  updated_at?: string;
  content_sha256?: string;
}

interface MemoryVersion {
  id: string;
  memory_id: string;
  operation: "create" | "update" | "delete" | "redact";
  created_at: string;
  path?: string;
  size_bytes?: number;
  actor?: { type: string; [key: string]: unknown };
}

function formatBytes(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTs(ts: string | undefined): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

export function MemoryDashboard() {
  const [stores, setStores] = useState<Store[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/proxy/admin/memory/stores");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { data: Store[] };
        if (!cancelled) setStores(json.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error)
    return <div className="text-sm text-red-600 dark:text-red-400">Failed to load: {error}</div>;
  if (!stores) return <div className="text-sm text-stone-500">Loading…</div>;
  if (stores.length === 0)
    return (
      <div className="text-sm text-stone-500">
        No memory stores in this workspace yet. Run{" "}
        <code className="font-mono text-xs">bun scripts/sync-agent-skills.ts --memory-stores</code>{" "}
        to create them.
      </div>
    );

  return (
    <div className="space-y-6">
      {stores.map((s) => (
        <StoreCard key={s.id} store={s} />
      ))}
    </div>
  );
}

function StoreCard({ store }: { store: Store }) {
  const [memories, setMemories] = useState<MemoryListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/proxy/admin/memory/stores/${encodeURIComponent(store.id)}/memories?path_prefix=/`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data: MemoryListItem[] };
      setMemories(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [store.id]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = memories?.filter(
    (m) => m.type === "memory" && (filter === "" || m.path.includes(filter)),
  );

  return (
    <div className="border border-stone-200 dark:border-stone-800 rounded-lg p-4">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="font-semibold text-stone-900 dark:text-stone-100">
            {store.name}
            {store.archived_at && (
              <span className="ml-2 text-xs text-stone-500 font-normal">(archived)</span>
            )}
          </h2>
          <p className="text-xs text-stone-500 font-mono">{store.id}</p>
        </div>
        <button
          type="button"
          onClick={load}
          className="text-xs text-stone-500 hover:text-stone-900 dark:hover:text-stone-100"
        >
          Refresh
        </button>
      </div>
      {store.description && (
        <p className="text-sm text-stone-600 dark:text-stone-400 mt-2">{store.description}</p>
      )}

      <div className="mt-4">
        <input
          type="text"
          placeholder="Filter by path…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-full px-2 py-1 text-sm border border-stone-200 dark:border-stone-800 rounded bg-transparent"
        />
      </div>

      {error && <div className="mt-3 text-xs text-red-600 dark:text-red-400">Error: {error}</div>}

      <div className="mt-3">
        {filtered === undefined ? (
          <div className="text-xs text-stone-500">Loading memories…</div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-stone-500">No memories.</div>
        ) : (
          <ul className="divide-y divide-stone-100 dark:divide-stone-900">
            {filtered.map((m) => (
              <MemoryRow key={m.id ?? m.path} storeId={store.id} memory={m} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MemoryRow({ storeId, memory }: { storeId: string; memory: MemoryListItem }) {
  const [expanded, setExpanded] = useState(false);
  const [versions, setVersions] = useState<MemoryVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadVersions = useCallback(async () => {
    if (!memory.id) return;
    try {
      const res = await fetch(
        `/api/proxy/admin/memory/stores/${encodeURIComponent(storeId)}/memories/${encodeURIComponent(
          memory.id,
        )}/versions`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data: MemoryVersion[] };
      setVersions(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [storeId, memory.id]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && versions === null) loadVersions();
  };

  return (
    <li className="py-2">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center justify-between gap-4 text-left hover:bg-stone-50 dark:hover:bg-stone-900 px-1 py-1 rounded"
      >
        <span className="font-mono text-xs text-stone-900 dark:text-stone-100">{memory.path}</span>
        <span className="text-xs text-stone-500 flex items-center gap-3">
          <span>{formatBytes(memory.size_bytes)}</span>
          <span>{formatTs(memory.updated_at)}</span>
          <span>{expanded ? "▾" : "▸"}</span>
        </span>
      </button>
      {expanded && (
        <div className="mt-2 pl-4 border-l border-stone-200 dark:border-stone-800">
          {error ? (
            <div className="text-xs text-red-600 dark:text-red-400">Error: {error}</div>
          ) : versions === null ? (
            <div className="text-xs text-stone-500">Loading versions…</div>
          ) : versions.length === 0 ? (
            <div className="text-xs text-stone-500">No versions retained.</div>
          ) : (
            <ul className="space-y-1 text-xs">
              {versions.map((v) => (
                <li key={v.id} className="flex gap-3 text-stone-600 dark:text-stone-400">
                  <span className="font-mono">{v.operation}</span>
                  <span>{formatTs(v.created_at)}</span>
                  <span className="text-stone-500">{v.actor?.type ?? ""}</span>
                  <span className="text-stone-500 font-mono">{v.id}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
