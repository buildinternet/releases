"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/auth-client";

type BootstrapStatus = "loading" | "unsigned" | "error" | "ready";

/**
 * Shared load gate for account settings panels that take an optional RSC
 * bootstrap payload and otherwise fetch once the session is ready.
 */
export function useSettingsBootstrap<T>(
  initial: T | null,
  fetchSettings: () => Promise<T>,
  loadErrorFallback: string,
): {
  data: T | null;
  status: BootstrapStatus;
  error: string | null;
  retry: () => void;
} {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;
  const [data, setData] = useState<T | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(initial == null);
  // Ignore concurrent retry()/effect fetches (unstable fetchSettings or rapid retry clicks).
  const inFlight = useRef(false);

  const retry = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      setData(await fetchSettings());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : loadErrorFallback);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [fetchSettings, loadErrorFallback]);

  useEffect(() => {
    if (data != null || error || inFlight.current) return;
    if (isPending) return;
    if (!user) {
      setLoading(false);
      return;
    }
    void retry();
  }, [data, error, isPending, user, retry]);

  if (data != null) return { data, status: "ready", error: null, retry };
  if (isPending || loading) return { data: null, status: "loading", error: null, retry };
  if (!user) return { data: null, status: "unsigned", error: null, retry };
  if (error) return { data: null, status: "error", error, retry };
  return { data: null, status: "loading", error: null, retry };
}
