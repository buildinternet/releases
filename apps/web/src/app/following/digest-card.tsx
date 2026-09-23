"use client";

import { useEffect, useState } from "react";
import type { DigestCadence } from "@buildinternet/releases-api-types";
import { getDigestCadence, setDigestCadence } from "@/lib/follows";

const OPTIONS: Array<{ value: DigestCadence; label: string }> = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

export function DigestCard() {
  const [cadence, setCadence] = useState<DigestCadence>("off");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDigestCadence()
      .then((c) => setCadence(c))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load digest setting."),
      )
      .finally(() => setLoading(false));
  }, []);

  async function choose(next: DigestCadence) {
    if (next === cadence || busy) return;
    setBusy(true);
    setError(null);
    const prev = cadence;
    setCadence(next); // optimistic
    try {
      setCadence(await setDigestCadence(next));
    } catch (err: unknown) {
      setCadence(prev);
      setError(err instanceof Error ? err.message : "Failed to update digest setting.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
        Email digest
      </h2>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
        Get an email with new releases from everything you follow.
      </p>

      {error && <p className="mt-2 text-[12px] text-red-600 dark:text-red-400">{error}</p>}

      <div
        className="mt-3 inline-flex overflow-hidden rounded border border-stone-200 dark:border-stone-700"
        role="group"
        aria-label="Email digest frequency"
      >
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={busy}
            aria-pressed={cadence === o.value}
            onClick={() => void choose(o.value)}
            className={`px-3 py-1.5 text-[13px] disabled:opacity-50 ${
              cadence === o.value
                ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
                : "bg-white text-stone-700 hover:bg-stone-50 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
