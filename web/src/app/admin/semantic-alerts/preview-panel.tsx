"use client";

import { useState } from "react";
import { inputClass } from "@releases/design-system";

const MAX_COUNT = 20;

type PreviewRelease = {
  id: string;
  title: string;
  theme: string;
  url: string;
};

type MatcherHit = {
  alertId: string;
  releaseId: string;
  probability: number | null;
  matched: boolean;
  threshold: number;
};

type PreviewResult = {
  inserted: number;
  published: number;
  seed: string;
  source: {
    id: string;
    slug: string;
    orgSlug: string;
    demo: boolean;
    followsEligible: boolean;
  };
  follow: { slug: string };
  releases: PreviewRelease[];
  matcher: {
    status: string;
    reason?: string;
    userId: string | null;
    matches: MatcherHit[];
  };
};

type PanelState =
  | { status: "idle" }
  | { status: "working"; action: "preview" | "purge" }
  | { status: "preview"; result: PreviewResult }
  | { status: "purged"; deleted: number }
  | { status: "error"; message: string };

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return body?.error?.message ?? `Request failed (${res.status}).`;
}

export function SemanticAlertPreviewPanel() {
  const [count, setCount] = useState(String(5));
  const [sourceId, setSourceId] = useState("");
  const [userId, setUserId] = useState("");
  const [state, setState] = useState<PanelState>({ status: "idle" });

  async function insert() {
    const parsed = Number(count);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_COUNT) {
      setState({
        status: "error",
        message: `Count must be a whole number from 1 to ${MAX_COUNT}.`,
      });
      return;
    }
    setState({ status: "working", action: "preview" });
    try {
      const res = await fetch("/api/proxy/admin/semantic-alerts/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          count: parsed,
          ...(sourceId.trim() ? { sourceId: sourceId.trim() } : {}),
          ...(userId.trim() ? { userId: userId.trim() } : {}),
        }),
      });
      if (!res.ok) {
        setState({ status: "error", message: await readError(res) });
        return;
      }
      setState({ status: "preview", result: (await res.json()) as PreviewResult });
    } catch {
      setState({ status: "error", message: "Network error — try again." });
    }
  }

  async function purge(target: string | null) {
    setState({ status: "working", action: "purge" });
    try {
      const res = await fetch("/api/proxy/admin/semantic-alerts/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target ? { sourceId: target } : {}),
      });
      if (!res.ok) {
        setState({ status: "error", message: await readError(res) });
        return;
      }
      const body = (await res.json()) as { deleted?: number };
      setState({ status: "purged", deleted: body.deleted ?? 0 });
    } catch {
      setState({ status: "error", message: "Network error — try again." });
    }
  }

  const busy = state.status === "working";

  return (
    <div className="space-y-8">
      <p className="text-sm text-stone-600 dark:text-stone-400">
        Generates plausible changelog entries and inserts them through the same batch path as
        production ingest, including <code>release.created</code> and webhook fanout. A blank source
        uses the dedicated <code>semantic-alerts-demo</code> org (visible so follows can include it,
        not featured, fetch paused). Titles start with <code>[demo]</code>. At most {MAX_COUNT} per
        request, and that org holds at most {MAX_COUNT} synthetic rows until you purge. Summaries
        and embeddings are skipped.
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
            Count
          </span>
          <input
            className={inputClass}
            inputMode="numeric"
            value={count}
            onChange={(event) => setCount(event.target.value)}
          />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
            Source
          </span>
          <input
            className={inputClass}
            placeholder="src_… or org/source — blank uses the demo source"
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
          />
        </label>
        <label className="block text-sm sm:col-span-3">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
            User id (optional match preview)
          </span>
          <input
            className={inputClass}
            placeholder="Better Auth user id — omitted skips matching"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void insert()}
          className="border border-stone-300 px-3 py-1.5 text-sm text-stone-800 transition hover:bg-stone-50 disabled:opacity-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-900"
        >
          {busy && state.action === "preview" ? "Inserting…" : "Insert demo releases"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void purge(sourceId.trim() || null)}
          className="border border-stone-300 px-3 py-1.5 text-sm text-stone-800 transition hover:bg-stone-50 disabled:opacity-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-900"
        >
          {busy && state.action === "purge" ? "Purging…" : "Purge synthetic rows"}
        </button>
      </div>

      {state.status === "error" ? (
        <p className="text-sm text-red-700 dark:text-red-400">{state.message}</p>
      ) : null}
      {state.status === "purged" ? (
        <p className="text-sm text-green-700 dark:text-green-400">
          Deleted {state.deleted} synthetic release{state.deleted === 1 ? "" : "s"}.
        </p>
      ) : null}
      {state.status === "preview" ? <PreviewResultView result={state.result} /> : null}
    </div>
  );
}

function PreviewResultView({ result }: { result: PreviewResult }) {
  const matcher =
    result.matcher.status === "scored"
      ? `${result.matcher.matches.filter((hit) => hit.matched).length} match${result.matcher.matches.filter((hit) => hit.matched).length === 1 ? "" : "es"} of ${result.matcher.matches.length} scored`
      : result.matcher.status === "unavailable"
        ? `Matcher unavailable${result.matcher.reason ? ` (${result.matcher.reason})` : ""}. Inserts and events still ran.`
        : result.matcher.status === "error"
          ? "Matcher failed closed. Inserts and events still ran."
          : "Matching skipped.";

  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-700 dark:text-stone-300">
        Inserted {result.inserted}, published {result.published} on{" "}
        <code>
          {result.source.orgSlug}/{result.source.slug}
        </code>
        . {matcher}
      </p>
      {result.source.followsEligible ? (
        <p className="text-sm text-stone-600 dark:text-stone-400">
          Follow <code>{result.follow.slug}</code> so these releases sit in that account&apos;s
          follows-scoped candidate pool.
        </p>
      ) : (
        <p className="text-sm text-stone-600 dark:text-stone-400">
          This source is hidden, so the follow feed (and the semantic-alert candidate pool) will not
          see these rows.
        </p>
      )}
      <ul className="divide-y divide-stone-200 border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
        {result.releases.map((release) => (
          <li key={release.id} className="px-4 py-3">
            <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
              {release.title}
            </p>
            <p className="text-[13px] text-stone-500 dark:text-stone-400">
              {release.theme} · <code>{release.id}</code>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
