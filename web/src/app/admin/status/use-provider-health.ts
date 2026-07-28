"use client";

import { useEffect, useState } from "react";
import type { ProviderHealthResponse } from "@buildinternet/releases-api-types";

export interface ProviderHealthState {
  data: ProviderHealthResponse | null;
  error: boolean;
  loading: boolean;
}

/**
 * Shared fetch for the provider/ingest health signal (#2168 postmortem) — one
 * network call, consumed by both the always-visible dashboard banner and the
 * Health tab's detail table, so switching tabs doesn't re-fetch.
 *
 * Fails open: a fetch error leaves `data: null` and `error: true` but never
 * throws, so a broken health query can't take down the rest of the status
 * page — the one thing this surface must not do is become another silent
 * outage.
 */
export function useProviderHealth(refreshMs = 60_000): ProviderHealthState {
  const [data, setData] = useState<ProviderHealthResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/proxy/admin/sources/health?limit=50")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
        .then((body: ProviderHealthResponse) => {
          if (cancelled) return;
          setData(body);
          setError(false);
        })
        .catch(() => {
          if (cancelled) return;
          setError(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const interval = setInterval(load, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refreshMs]);

  return { data, error, loading };
}
