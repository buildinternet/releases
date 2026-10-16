"use client";

import { useRef, useState } from "react";
import type {
  AdminDatasetSource,
  AdminDatasetsResponse,
  SourceDatasetSettings,
} from "@buildinternet/releases-api-types";
import { inputClass, primaryButtonClass, smallButtonClass } from "@releases/design-system";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };
export interface DatasetActions {
  getSources: (query: string, page: number) => Promise<Result<AdminDatasetsResponse>>;
  saveSource: (id: string, settings: SourceDatasetSettings | null) => Promise<Result<null>>;
}

function DatasetSourceForm({
  source,
  busy,
  onSave,
}: {
  source: AdminDatasetSource;
  busy: boolean;
  onSave: (settings: SourceDatasetSettings | null) => Promise<Result<null>>;
}) {
  const [mode, setMode] = useState(
    source.settings?.enabled === undefined
      ? "default"
      : source.settings.enabled
        ? "enabled"
        : "disabled",
  );
  const [name, setName] = useState(source.settings?.name ?? "");
  const [description, setDescription] = useState(source.settings?.description ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [savedSettings, setSavedSettings] = useState(source.settings);
  const selected = source.settings?.enabled ?? source.defaultEnabled;
  const settings: SourceDatasetSettings = {
    ...(mode === "default" ? {} : { enabled: mode === "enabled" }),
    ...(name.trim() ? { name: name.trim() } : {}),
    ...(description.trim() ? { description: description.trim() } : {}),
  };
  const patch = Object.keys(settings).length ? settings : null;
  const dirty =
    patch?.enabled !== savedSettings?.enabled ||
    patch?.name !== savedSettings?.name ||
    patch?.description !== savedSettings?.description;
  const descriptionInvalid = description.trim().length > 0 && description.trim().length < 50;

  async function save(reset: boolean) {
    setMessage(null);
    try {
      const res = await onSave(reset ? null : patch);
      setError(!res.ok);
      setMessage(res.ok ? "Saved." : res.error);
      if (res.ok) {
        setSavedSettings(reset ? null : patch);
        if (reset) {
          setMode("default");
          setName("");
          setDescription("");
        }
      }
    } catch {
      setError(true);
      setMessage("The save could not be confirmed. Refresh before trying again.");
    }
  }

  return (
    <form
      className="rounded-xl border border-stone-200 p-4 dark:border-stone-800"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && dirty && !descriptionInvalid) void save(false);
      }}
    >
      <div className="mb-4">
        <h2 className="text-sm font-semibold">{source.name}</h2>
        <p className="text-xs text-stone-500">
          {source.orgName ?? source.orgSlug ?? "No organization"} ·{" "}
          {source.orgSlug ? `${source.orgSlug}/` : ""}
          {source.slug}
        </p>
        <p className="mt-2 text-sm">
          {selected ? "Selected" : "Not selected"} ·{" "}
          {source.blockedReasons.length > 0
            ? "Public indexing blocked"
            : source.effective
              ? "Public dataset active"
              : "No public dataset"}
        </p>
        {source.effective ? (
          <div className="mt-2 text-sm text-stone-600 dark:text-stone-300">
            <p className="font-medium">{source.effective.name}</p>
            <p>{source.effective.description}</p>
          </div>
        ) : null}
        {source.blockedReasons.length ? (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
            Blocked: {source.blockedReasons.join(" · ")}
          </p>
        ) : null}
      </div>
      <fieldset disabled={busy} className="space-y-3">
        <legend className="sr-only">Dataset settings for {source.name}</legend>
        <label className="block text-sm" htmlFor={`${source.id}-mode`}>
          Dataset selection
          <select
            id={`${source.id}-mode`}
            className={`${inputClass} mt-1 w-full`}
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="default">
              Default ({source.defaultEnabled ? "enabled" : "disabled"})
            </option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <label className="block text-sm" htmlFor={`${source.id}-name`}>
          Custom dataset name
          <input
            id={`${source.id}-name`}
            className={`${inputClass} mt-1 w-full`}
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block text-sm" htmlFor={`${source.id}-description`}>
          Custom dataset description
          <textarea
            id={`${source.id}-description`}
            className={`${inputClass} mt-1 min-h-24 w-full`}
            value={description}
            maxLength={5000}
            aria-describedby={`${source.id}-copy-help`}
            aria-invalid={descriptionInvalid || undefined}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <p id={`${source.id}-copy-help`} className="text-xs text-stone-500">
          Leave copy blank to inherit defaults. A custom description needs 50–5,000 characters.
          Enabling a source cannot override a blocked reason.
        </p>
        {descriptionInvalid ? (
          <p className="text-sm text-red-600" role="alert">
            Use at least 50 characters for a custom description.
          </p>
        ) : null}
        <div className="flex gap-2">
          <button
            type="submit"
            className={primaryButtonClass}
            disabled={busy || !dirty || descriptionInvalid}
          >
            Save dataset
          </button>
          <button
            type="button"
            className={smallButtonClass}
            disabled={busy || savedSettings === null}
            onClick={() => void save(true)}
          >
            Reset to default
          </button>
        </div>
      </fieldset>
      {message ? (
        <p
          className={`mt-2 text-sm ${error ? "text-red-600" : "text-stone-500"}`}
          role={error ? "alert" : "status"}
        >
          {message}
        </p>
      ) : null}
    </form>
  );
}

export function DatasetsForm({
  initial,
  initialError,
  actions,
}: {
  initial: AdminDatasetsResponse | null;
  initialError?: string;
  actions: DatasetActions;
}) {
  const [state, setState] = useState(initial);
  const [query, setQuery] = useState(initial?.query ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const locked = useRef(false);

  async function load(page: number, search: string) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await actions.getSources(search, page);
      if (result.ok) setState(result.data);
      else setError(result.error);
    } catch {
      setError("Could not load datasets. Try again.");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  async function save(id: string, settings: SourceDatasetSettings | null): Promise<Result<null>> {
    if (locked.current) return { ok: false, error: "Another change is still in progress." };
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await actions.saveSource(id, settings);
      if (!result.ok) return result;
      setNotice("Dataset settings saved.");
      try {
        const refreshed = await actions.getSources(state?.query ?? "", state?.pagination.page ?? 1);
        if (refreshed.ok) setState(refreshed.data);
        else
          setError(
            "Saved, but the public status could not be refreshed. Refresh the list to check it.",
          );
      } catch {
        setError(
          "Saved, but the public status could not be refreshed. Refresh the list to check it.",
        );
      }
      return result;
    } catch {
      return { ok: false, error: "The save could not be confirmed. Refresh before trying again." };
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[860px] space-y-4" aria-busy={busy}>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void load(1, query);
        }}
      >
        <label htmlFor="dataset-search" className="flex-1 text-sm">
          Search organization or source
          <input
            id="dataset-search"
            className={`${inputClass} mt-1 w-full`}
            value={query}
            disabled={busy}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          Search
        </button>
        <button
          type="button"
          className={smallButtonClass}
          disabled={busy}
          onClick={() => void load(state?.pagination.page ?? 1, state?.query ?? "")}
        >
          Refresh list
        </button>
      </form>
      {busy ? (
        <p className="text-sm text-stone-500" role="status">
          Updating datasets…
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="text-sm text-stone-500" role="status">
          {notice}
        </p>
      ) : null}
      {state?.sources.length === 0 ? (
        <p className="text-sm text-stone-500">No sources match this search.</p>
      ) : null}
      {state?.sources.map((source) => (
        <DatasetSourceForm
          key={`${source.id}:${JSON.stringify(source.settings)}`}
          source={source}
          busy={busy}
          onSave={(settings) => save(source.id, settings)}
        />
      ))}
      {state ? (
        <nav aria-label="Dataset source pages" className="flex items-center gap-3">
          <button
            type="button"
            className={smallButtonClass}
            disabled={busy || state.pagination.page <= 1}
            onClick={() => void load(state.pagination.page - 1, state.query)}
          >
            Previous
          </button>
          <span className="text-sm">Page {state.pagination.page}</span>
          <button
            type="button"
            className={smallButtonClass}
            disabled={busy || !state.pagination.hasMore}
            onClick={() => void load(state.pagination.page + 1, state.query)}
          >
            Next
          </button>
        </nav>
      ) : null}
    </div>
  );
}
