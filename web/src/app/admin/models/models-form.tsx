"use client";

import { useMemo, useState } from "react";
import type {
  AiLaneId,
  AiLaneModelsResponse,
  AiLaneState,
  OpenRouterCatalogModel,
} from "@buildinternet/releases-api-types";
import { inputClass, primaryButtonClass, smallButtonClass } from "@releases/design-system";
import { setAiLaneModelAction } from "@/app/actions/ai-models";

function formatPrice(n: number | null): string | null {
  if (n == null) return null;
  if (n === 0) return "free";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function priceLabel(m: OpenRouterCatalogModel): string | null {
  const prompt = formatPrice(m.promptPricePerMillion);
  const completion = formatPrice(m.completionPricePerMillion);
  if (!prompt && !completion) return null;
  return `${prompt ?? "—"} / ${completion ?? "—"} per 1M`;
}

function catalogName(catalog: OpenRouterCatalogModel[], id: string | null): string | null {
  if (!id) return null;
  return catalog.find((m) => m.id === id)?.name ?? null;
}

function LanePicker({
  lane,
  catalog,
  onSaved,
}: {
  lane: AiLaneState;
  catalog: OpenRouterCatalogModel[];
  onSaved: (next: AiLaneModelsResponse) => void;
}) {
  const [query, setQuery] = useState(lane.override ?? lane.effective ?? "");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q
      ? catalog.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      : catalog;
    return rows.slice(0, 40);
  }, [catalog, query]);

  const dirty = query.trim() !== (lane.override ?? lane.effective ?? "");
  const clearing = query.trim() === "" && lane.override != null;

  async function save(value: string | null) {
    setSaving(true);
    setResult(null);
    const res = await setAiLaneModelAction(lane.id as AiLaneId, value);
    setSaving(false);
    if (!res.ok) {
      setResult(res.error);
      return;
    }
    onSaved(res.data);
    const updated = res.data.lanes.find((l) => l.id === lane.id);
    setQuery(updated?.override ?? updated?.effective ?? "");
    setResult(value == null ? "Reverted to wrangler default." : "Saved.");
    setOpen(false);
  }

  return (
    <section className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">{lane.label}</h2>
        <p className="mt-0.5 text-[13px] text-stone-500 dark:text-stone-400">{lane.description}</p>
      </div>

      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
        Model
      </label>
      <div className="relative">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setResult(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            window.setTimeout(() => setOpen(false), 150);
          }}
          placeholder="Search OpenRouter models…"
          className={inputClass}
          autoComplete="off"
          spellCheck={false}
        />
        {open && matches.length > 0 && (
          <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-[9px] border border-stone-200 bg-white py-1 shadow-lg dark:border-stone-700 dark:bg-stone-950">
            {matches.map((m) => {
              const price = priceLabel(m);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-stone-50 dark:hover:bg-stone-900"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setQuery(m.id);
                      setOpen(false);
                    }}
                  >
                    <span className="font-medium text-stone-900 dark:text-stone-100">
                      {m.name}
                      {m.vision ? (
                        <span className="ml-2 text-[11px] font-normal uppercase tracking-wide text-stone-400">
                          vision
                        </span>
                      ) : null}
                    </span>
                    <span className="font-mono text-[11px] text-stone-500">
                      {m.id}
                      {price ? ` · ${price}` : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="mt-2 text-[12px] text-stone-500 dark:text-stone-400">
        Wrangler default:{" "}
        <code className="font-mono text-[11px]">
          {lane.wranglerDefault ?? "(empty → Anthropic Haiku)"}
        </code>
        {lane.override ? (
          <>
            {" "}
            · live override: <code className="font-mono text-[11px]">{lane.override}</code>
          </>
        ) : (
          " · no override"
        )}
        {catalogName(catalog, lane.effective) ? (
          <> · {catalogName(catalog, lane.effective)}</>
        ) : null}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={saving || (!dirty && !clearing)}
          onClick={() => save(query.trim() || null)}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {lane.override ? (
          <button
            type="button"
            className={smallButtonClass}
            disabled={saving}
            onClick={() => save(null)}
          >
            Use wrangler default
          </button>
        ) : null}
        {result ? (
          <span className="text-[13px] text-stone-600 dark:text-stone-300">{result}</span>
        ) : null}
      </div>
    </section>
  );
}

export function ModelsForm({ initial }: { initial: AiLaneModelsResponse }) {
  const [state, setState] = useState(initial);

  return (
    <div className="max-w-[720px] space-y-4">
      {state.catalogError ? (
        <p className="text-[13px] text-amber-700 dark:text-amber-400">
          OpenRouter catalog unavailable ({state.catalogError}). You can still paste a model id.
        </p>
      ) : (
        <p className="text-[13px] text-stone-500 dark:text-stone-400">
          {state.catalog.length.toLocaleString()} text models from OpenRouter
          {state.catalogFetchedAt
            ? ` · fetched ${new Date(state.catalogFetchedAt).toLocaleString()}`
            : ""}
          . Changes apply on the next AI call (within ~30s).
        </p>
      )}
      {state.lanes.map((lane) => (
        <LanePicker key={lane.id} lane={lane} catalog={state.catalog} onSaved={setState} />
      ))}
    </div>
  );
}
