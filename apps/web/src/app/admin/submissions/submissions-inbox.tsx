"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { listCardClass, listRowClass, smallButtonClass } from "@releases/design-system";
import { LocalTimestamp } from "@/components/local-timestamp";
import {
  isTriageable,
  SUBMISSION_KIND_LABEL,
  SUBMISSION_KINDS,
  type SubmissionItem,
  type SubmissionKind,
  type SubmissionsQuery,
  type SubmissionsResponse,
} from "@/lib/admin-submissions";

type ListResult = { ok: true; data: SubmissionsResponse } | { ok: false; error: string };
type TriageResult = { ok: true } | { ok: false; error: string };

/**
 * Server-action seam, injected rather than imported so this "use client" tree
 * stays free of the `"use server"` module's `server-only` import chain and the
 * test can render it with plain fakes (same pattern as the classifier panel).
 */
export interface SubmissionsActions {
  list: (query: SubmissionsQuery) => Promise<ListResult>;
  triage: (
    kind: "recommendation" | "feedback",
    id: string,
    patch: { status?: "new" | "triaged" | "closed"; archived?: boolean },
  ) => Promise<TriageResult>;
}

const KIND_BADGE: Record<SubmissionKind, string> = {
  recommendation: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  feedback: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
  "tracking-request": "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  claim: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
};

const chipBase =
  "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition";
const chipOn =
  "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900";
const chipOff =
  "border-stone-200 bg-white text-stone-700 hover:border-stone-300 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200";

const linkClass =
  "text-[12.5px] font-medium text-stone-600 underline-offset-2 hover:text-stone-900 hover:underline dark:text-stone-400 dark:hover:text-stone-100";

function totalOpen(counts: Record<SubmissionKind, number>): number {
  return SUBMISSION_KINDS.reduce((sum, k) => sum + (counts[k] ?? 0), 0);
}

function Row({
  item,
  busy,
  onTriage,
}: {
  item: SubmissionItem;
  busy: boolean;
  onTriage: (
    item: SubmissionItem,
    patch: { status?: "new" | "triaged" | "closed"; archived?: boolean },
  ) => void;
}) {
  const triageable = isTriageable(item.kind);
  return (
    <li className={`${listRowClass} items-start ${item.open ? "" : "opacity-60"}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-stone-500 dark:text-stone-400">
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${KIND_BADGE[item.kind]}`}
          >
            {SUBMISSION_KIND_LABEL[item.kind]}
          </span>
          <span className="font-mono">{item.status}</span>
          {item.archived && <span className="font-mono">archived</span>}
          {item.surface && <span>via {item.surface}</span>}
          {item.createdAt > 0 && <LocalTimestamp iso={new Date(item.createdAt).toISOString()} />}
        </div>
        <p
          className={`mt-1 text-sm font-medium text-stone-900 dark:text-stone-100 ${
            item.kind === "feedback" ? "line-clamp-3 whitespace-pre-line" : "truncate"
          }`}
          title={item.title}
        >
          {item.title}
        </p>
        {item.detail && (
          <p className="mt-0.5 line-clamp-2 text-[13px] text-stone-500 dark:text-stone-400">
            {item.detail}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-3">
          {item.contact && (
            <a href={`mailto:${item.contact}`} className={linkClass}>
              {item.contact}
            </a>
          )}
          {item.url && (
            <a href={item.url} target="_blank" rel="noreferrer noopener" className={linkClass}>
              Open link
            </a>
          )}
          {item.org && (
            <Link href={`/${item.org.slug}`} className={linkClass}>
              View {item.org.name}
            </Link>
          )}
          <span className="font-mono text-[11px] text-stone-400 dark:text-stone-500">
            {item.id}
          </span>
        </div>
      </div>
      {triageable && (
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {item.status === "new" && !item.archived && (
            <button
              type="button"
              className={smallButtonClass}
              disabled={busy}
              onClick={() => onTriage(item, { status: "triaged" })}
            >
              Triage
            </button>
          )}
          {item.status !== "closed" ? (
            <button
              type="button"
              className={smallButtonClass}
              disabled={busy}
              onClick={() => onTriage(item, { status: "closed" })}
            >
              Close
            </button>
          ) : (
            <button
              type="button"
              className={smallButtonClass}
              disabled={busy}
              onClick={() => onTriage(item, { status: "new" })}
            >
              Reopen
            </button>
          )}
          <button
            type="button"
            className={smallButtonClass}
            disabled={busy}
            onClick={() => onTriage(item, { archived: !item.archived })}
          >
            {item.archived ? "Unarchive" : "Archive"}
          </button>
        </div>
      )}
    </li>
  );
}

export function SubmissionsInbox({
  initial,
  initialError,
  actions,
}: {
  initial: SubmissionsResponse | null;
  initialError: string | null;
  actions: SubmissionsActions;
}) {
  const [data, setData] = useState<SubmissionsResponse | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [kind, setKind] = useState<SubmissionKind | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reload(next: { kind: SubmissionKind | null; showClosed: boolean }) {
    startTransition(async () => {
      const res = await actions.list({ kind: next.kind, state: next.showClosed ? "all" : "open" });
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else {
        setError(res.error);
      }
    });
  }

  function selectKind(next: SubmissionKind | null) {
    setKind(next);
    reload({ kind: next, showClosed });
  }

  function toggleClosed(next: boolean) {
    setShowClosed(next);
    reload({ kind, showClosed: next });
  }

  function triage(
    item: SubmissionItem,
    patch: { status?: "new" | "triaged" | "closed"; archived?: boolean },
  ) {
    if (!isTriageable(item.kind)) return;
    const triageKind = item.kind;
    setBusyId(item.id);
    startTransition(async () => {
      const res = await actions.triage(triageKind, item.id, patch);
      setBusyId(null);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      reload({ kind, showClosed });
    });
  }

  const counts = data?.openCounts;
  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${chipBase} ${kind === null ? chipOn : chipOff}`}
          onClick={() => selectKind(null)}
        >
          All{counts ? <span className="opacity-70">{totalOpen(counts)}</span> : null}
        </button>
        {SUBMISSION_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={`${chipBase} ${kind === k ? chipOn : chipOff}`}
            onClick={() => selectKind(k)}
          >
            {SUBMISSION_KIND_LABEL[k]}
            {counts ? <span className="opacity-70">{counts[k] ?? 0}</span> : null}
          </button>
        ))}
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[12.5px] text-stone-600 dark:text-stone-400">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => toggleClosed(e.target.checked)}
            className="rounded border-stone-300 dark:border-stone-600"
          />
          Show closed
        </label>
      </div>

      <p className="text-[12px] text-stone-500 dark:text-stone-400">
        Counts are open items. Open means not closed or archived, a tracking request that is still a
        stub, or a claim that is pending or verified.
      </p>

      {error && <p className="text-sm font-medium text-red-600 dark:text-red-400">{error}</p>}

      {items.length === 0 ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">
          {pending ? "Loading…" : data ? "Nothing here. Inbox zero." : null}
        </p>
      ) : (
        <ul className={`${listCardClass} ${pending ? "opacity-70" : ""}`}>
          {items.map((item) => (
            <Row
              key={`${item.kind}:${item.id}`}
              item={item}
              busy={busyId === item.id}
              onTriage={triage}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
