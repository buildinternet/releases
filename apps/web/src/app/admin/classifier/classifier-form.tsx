"use client";

import { useState } from "react";
import type {
  MarketingClassifierState,
  MarketingFilteredSource,
} from "@buildinternet/releases-api-types";
import { inputClass, primaryButtonClass, smallButtonClass } from "@releases/design-system";

const THRESHOLD_MIN = 0.5;
const THRESHOLD_MAX = 0.99;
const THRESHOLD_STEP = 0.01;

type SetThresholdResult =
  | { ok: true; data: MarketingClassifierState }
  | { ok: false; error: string };
type SourcePatchResult = { ok: true } | { ok: false; error: string };

/**
 * Server-action seam, injected rather than imported directly. Keeps this
 * "use client" tree free of the `"use server"` action module's import chain
 * (which pulls in `server-only` and throws outside a request), so
 * `classifier-form.test.tsx` can render it with plain fakes.
 */
export interface ClassifierActions {
  getState: () => Promise<MarketingClassifierState | null>;
  setThreshold: (threshold: number) => Promise<SetThresholdResult>;
  setSourceFilter: (
    sourceId: string,
    patch: { marketingFilter?: boolean; marketingFilterHint?: string | null },
  ) => Promise<SourcePatchResult>;
}

function ThresholdControl({
  state,
  actions,
  onSaved,
}: {
  state: MarketingClassifierState;
  actions: ClassifierActions;
  onSaved: (next: MarketingClassifierState) => void;
}) {
  const [value, setValue] = useState(state.threshold);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const dirty = value !== state.threshold;

  async function save() {
    setSaving(true);
    setResult(null);
    const res = await actions.setThreshold(value);
    setSaving(false);
    if (!res.ok) {
      setResult(res.error);
      return;
    }
    onSaved(res.data);
    setResult("Saved.");
  }

  return (
    <section className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
      <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
        Suppression threshold
      </h2>
      <p className="mt-0.5 text-[13px] text-stone-500 dark:text-stone-400">
        A marketing-labeled item suppresses only when the model&apos;s selected-choice probability
        is at or above this value. Higher = fewer false positives, more marketing slipping through.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          type="range"
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          step={THRESHOLD_STEP}
          value={value}
          onChange={(e) => {
            setValue(Number(e.target.value));
            setResult(null);
          }}
          className="h-2 w-56 accent-stone-700 dark:accent-stone-300"
        />
        <input
          type="number"
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          step={THRESHOLD_STEP}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) {
              setValue(n);
              setResult(null);
            }
          }}
          className={`${inputClass} w-24`}
        />
      </div>

      <p className="mt-2 text-[12px] text-stone-500 dark:text-stone-400">
        Code default: <code className="font-mono text-[11px]">{state.defaultThreshold}</code>
        {state.updatedAt ? (
          <>
            {" "}
            · last updated{" "}
            <span title={state.updatedAt}>{new Date(state.updatedAt).toLocaleString()}</span>
          </>
        ) : (
          " · no operator override stored"
        )}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={saving || !dirty}
          onClick={save}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {value !== state.defaultThreshold ? (
          <button
            type="button"
            className={smallButtonClass}
            disabled={saving}
            onClick={() => setValue(state.defaultThreshold)}
          >
            Reset to default
          </button>
        ) : null}
        {result ? (
          <span className="text-[13px] text-stone-600 dark:text-stone-300">{result}</span>
        ) : null}
      </div>
    </section>
  );
}

function SourceRow({
  source,
  actions,
  onChanged,
}: {
  source: MarketingFilteredSource;
  actions: ClassifierActions;
  onChanged: () => void;
}) {
  const [hint, setHint] = useState(source.hint ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disable() {
    setBusy(true);
    setError(null);
    const res = await actions.setSourceFilter(source.id, { marketingFilter: false });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onChanged();
  }

  async function saveHint() {
    setBusy(true);
    setError(null);
    const res = await actions.setSourceFilter(source.id, {
      marketingFilterHint: hint.trim() || null,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onChanged();
  }

  return (
    <tr className="border-b border-stone-100 last:border-0 dark:border-stone-800">
      <td className="py-2 pr-3">
        <div className="text-sm text-stone-900 dark:text-stone-100">{source.name}</div>
        <div className="font-mono text-[11px] text-stone-500">
          {source.orgSlug ? `${source.orgSlug}/` : ""}
          {source.slug} · {source.type}
        </div>
      </td>
      <td className="py-2 pr-3 text-sm text-stone-600 dark:text-stone-300">
        {source.recentReleaseCount}
      </td>
      <td className="py-2 pr-3">
        <input
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          placeholder="Optional hint for the classifier"
          className={`${inputClass} w-full min-w-[220px]`}
        />
      </td>
      <td className="py-2 pl-2 text-right">
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={smallButtonClass}
            disabled={busy || hint.trim() === (source.hint ?? "")}
            onClick={saveHint}
          >
            Save hint
          </button>
          <button type="button" className={smallButtonClass} disabled={busy} onClick={disable}>
            Turn off
          </button>
        </div>
        {error ? <p className="mt-1 text-[12px] text-red-600 dark:text-red-400">{error}</p> : null}
      </td>
    </tr>
  );
}

function AddSourceRow({ actions, onAdded }: { actions: ClassifierActions; onAdded: () => void }) {
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const id = sourceId.trim();
    if (!id.startsWith("src_")) {
      setError('Source id must start with "src_" — copy it from the source page or the CLI.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await actions.setSourceFilter(id, { marketingFilter: true });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSourceId("");
    onAdded();
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <input
        value={sourceId}
        onChange={(e) => setSourceId(e.target.value)}
        placeholder="src_… to turn the filter on"
        className={`${inputClass} w-64`}
        spellCheck={false}
        autoComplete="off"
      />
      <button
        type="button"
        className={smallButtonClass}
        disabled={busy || sourceId.trim() === ""}
        onClick={add}
      >
        {busy ? "Adding…" : "Turn on"}
      </button>
      {error ? <span className="text-[12px] text-red-600 dark:text-red-400">{error}</span> : null}
    </div>
  );
}

export function ClassifierForm({
  initial,
  actions,
}: {
  initial: MarketingClassifierState;
  actions: ClassifierActions;
}) {
  const [state, setState] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    const res = await actions.getState();
    setRefreshing(false);
    if (res) setState(res);
  }

  return (
    <div className="max-w-[860px] space-y-4">
      <ThresholdControl state={state} actions={actions} onSaved={setState} />

      <section className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Filtered sources
            </h2>
            <p className="mt-0.5 text-[13px] text-stone-500 dark:text-stone-400">
              Sources with <code className="font-mono text-[11px]">metadata.marketingFilter</code>{" "}
              on. Edits go through the source metadata route directly — no separate store.
            </p>
          </div>
          {refreshing ? <span className="text-[12px] text-stone-400">Refreshing…</span> : null}
        </div>

        {state.sources.length === 0 ? (
          <p className="text-sm text-stone-500">No sources have the filter on.</p>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-stone-200 text-[11px] uppercase tracking-wide text-stone-400 dark:border-stone-800">
                <th className="pb-2 pr-3 font-medium">Source</th>
                <th className="pb-2 pr-3 font-medium">Releases (30d)</th>
                <th className="pb-2 pr-3 font-medium">Hint</th>
                <th className="pb-2 pl-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {state.sources.map((s) => (
                <SourceRow key={s.id} source={s} actions={actions} onChanged={refresh} />
              ))}
            </tbody>
          </table>
        )}

        <AddSourceRow actions={actions} onAdded={refresh} />
      </section>
    </div>
  );
}
