"use client";

import { useEffect, useState, useTransition } from "react";
import {
  ErrorText,
  fieldLabelClass,
  inputClass,
  smallButtonClass,
  smallPrimaryButtonClass,
} from "@releases/design-system";
import type {
  ApproveRecommendationInput,
  ApproveRecommendationResult,
  PromoteResult,
  RecommendationPlan,
  Result,
  SubmissionItem,
} from "@/lib/admin-submissions";

/** Server actions the review panels call (injected, like the inbox's own seam). */
export interface ReviewActions {
  plan: (id: string) => Promise<Result<RecommendationPlan>>;
  approve: (input: ApproveRecommendationInput) => Promise<Result<ApproveRecommendationResult>>;
  promote: (slug: string, dryRun: boolean) => Promise<Result<PromoteResult>>;
}

interface PanelProps {
  item: SubmissionItem;
  actions: ReviewActions;
  /** Called after a successful write with a one-line summary for the inbox. */
  onDone: (notice: string) => void;
  onCancel: () => void;
}

const panelClass =
  "mt-3 basis-full space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900/50";
const noteClass = "text-[12.5px] text-stone-500 dark:text-stone-400";
const warnClass = "text-[12.5px] font-medium text-amber-700 dark:text-amber-400";

/** Load once on mount; `null` while loading. */
function useLoad<T>(load: () => Promise<Result<T>>): Result<T> | null {
  const [state, setState] = useState<Result<T> | null>(null);
  useEffect(() => {
    let live = true;
    void load().then((r) => live && setState(r));
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- load once per panel open
  }, []);
  return state;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0 flex-1">
      <span className={fieldLabelClass}>{label}</span>
      {children}
    </label>
  );
}

/** Approve a source suggestion: prefilled from the plan route, editable, then created. */
export function ApprovePanel(props: PanelProps) {
  const loaded = useLoad(() => props.actions.plan(props.item.id));
  if (!loaded) return <div className={panelClass}>Checking the URL…</div>;
  if (!loaded.ok) {
    return (
      <div className={panelClass}>
        <ErrorText>{loaded.error}</ErrorText>
        <button type="button" className={smallButtonClass} onClick={props.onCancel}>
          Close
        </button>
      </div>
    );
  }
  return <ApproveForm plan={loaded.data} {...props} />;
}

export function ApproveForm({
  plan,
  item,
  actions,
  onDone,
  onCancel,
}: PanelProps & { plan: RecommendationPlan }) {
  const [useExisting, setUseExisting] = useState(plan.matchedOrg !== null);
  const [orgSlug, setOrgSlug] = useState(plan.matchedOrg?.slug ?? "");
  const [newOrg, setNewOrg] = useState(plan.newOrg);
  const [source, setSource] = useState(plan.source);
  const [fetchNow, setFetchNow] = useState(true);
  const [notify, setNotify] = useState(item.contact !== null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await actions.approve({
        recommendationId: item.id,
        org: useExisting ? { slug: orgSlug.trim() } : { create: newOrg },
        source,
        fetchNow,
        notify,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const { orgSlug: o, sourceSlug: s, warnings } = res.data;
      onDone([`Added ${o}/${s}.`, ...warnings].join(" "));
    });
  }

  return (
    <form className={panelClass} onSubmit={submit}>
      <p className={noteClass}>
        Detected <span className="font-mono">{plan.evaluation.recommendedMethod}</span> (
        {plan.evaluation.confidence} confidence)
        {plan.evaluation.feedUrl ? `, feed ${plan.evaluation.feedUrl}` : ""}.
      </p>
      {plan.existingSource && (
        <p className={warnClass}>
          Already tracked as {plan.existingSource.orgSlug}/{plan.existingSource.slug}. Approving
          would add a duplicate; you probably want Close instead.
        </p>
      )}

      <div className="flex flex-wrap gap-4 text-[13px]">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={useExisting} onChange={() => setUseExisting(true)} />
          Existing org
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={!useExisting} onChange={() => setUseExisting(false)} />
          New org
        </label>
      </div>
      {useExisting ? (
        <Field label="Org slug">
          <input
            className={inputClass}
            value={orgSlug}
            onChange={(e) => setOrgSlug(e.target.value)}
            required
          />
        </Field>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Field label="Org name">
            <input
              className={inputClass}
              value={newOrg.name}
              onChange={(e) => setNewOrg({ ...newOrg, name: e.target.value })}
              required
            />
          </Field>
          <Field label="Org slug">
            <input
              className={inputClass}
              value={newOrg.slug}
              onChange={(e) => setNewOrg({ ...newOrg, slug: e.target.value })}
              required
            />
          </Field>
          <Field label="Domain">
            <input
              className={inputClass}
              value={newOrg.domain ?? ""}
              onChange={(e) => setNewOrg({ ...newOrg, domain: e.target.value || null })}
            />
          </Field>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <Field label="Source name">
          <input
            className={inputClass}
            value={source.name}
            onChange={(e) => setSource({ ...source, name: e.target.value })}
            required
          />
        </Field>
        <Field label="Type">
          <select
            className={inputClass}
            value={source.type}
            onChange={(e) => setSource({ ...source, type: e.target.value as typeof source.type })}
          >
            <option value="feed">feed</option>
            <option value="github">github</option>
            <option value="scrape">scrape</option>
          </select>
        </Field>
      </div>
      <Field label="URL">
        <input
          className={inputClass}
          value={source.url}
          onChange={(e) => setSource({ ...source, url: e.target.value })}
          required
        />
      </Field>

      <div className="flex flex-wrap gap-4 text-[13px]">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={fetchNow}
            onChange={(e) => setFetchNow(e.target.checked)}
          />
          Fetch now
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={notify}
            disabled={item.contact === null}
            onChange={(e) => setNotify(e.target.checked)}
          />
          {item.contact ? `Email ${item.contact}` : "No submitter email"}
        </label>
      </div>

      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex gap-2">
        <button type="submit" className={smallPrimaryButtonClass} disabled={pending}>
          {pending ? "Adding…" : "Add source"}
        </button>
        <button type="button" className={smallButtonClass} onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Promote a stub org: shows the dry-run materialization plan, then runs it. */
export function PromotePanel({ item, actions, onDone, onCancel }: PanelProps) {
  const org = item.org!;
  const preview = useLoad(() => actions.promote(org.slug, true));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      const res = await actions.promote(org.slug, false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const { sourcesCreated, sourcesMatched } = res.data;
      onDone(
        `Promoted ${org.name} to tracked: ${sourcesCreated} source(s) created, ${sourcesMatched} matched.`,
      );
    });
  }

  if (!preview) return <div className={panelClass}>Building the promotion plan…</div>;
  if (!preview.ok) {
    return (
      <div className={panelClass}>
        <ErrorText>{preview.error}</ErrorText>
        <button type="button" className={smallButtonClass} onClick={onCancel}>
          Close
        </button>
      </div>
    );
  }
  const planned = preview.data.plan?.sources ?? [];

  return (
    <div className={panelClass}>
      {planned.length === 0 ? (
        <p className={noteClass}>
          No declared release locations. Promoting only flips the org to tracked; add sources by
          hand afterwards.
        </p>
      ) : (
        <ul className="space-y-1 text-[12.5px]">
          {planned.map((s) => (
            <li key={`${s.type}:${s.locator}`} className="flex flex-wrap gap-2">
              <span className="font-mono text-stone-500">{s.action}</span>
              <span className="font-mono text-stone-500">{s.type}</span>
              <span className="min-w-0 truncate text-stone-800 dark:text-stone-200">
                {s.locator}
              </span>
              {s.paused && (
                <span className="text-amber-700 dark:text-amber-400">paused for review</span>
              )}
              {s.note && <span className="text-stone-500">{s.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex gap-2">
        <button type="button" className={smallPrimaryButtonClass} disabled={pending} onClick={run}>
          {pending ? "Promoting…" : "Promote to tracked"}
        </button>
        <button type="button" className={smallButtonClass} onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </div>
  );
}
