"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  GENDER_OPTIONS,
  SEXUAL_ORIENTATION_OPTIONS,
  type GenderOption,
  type SexualOrientationOption,
  type UserDemographics,
} from "@buildinternet/releases-api-types";
import { useSession } from "@/lib/auth-client";
import { getDemographics, updateDemographics } from "@/lib/demographics";

const labelClass = "block text-sm font-medium text-stone-700 dark:text-stone-200";
const inputClass =
  "mt-1 w-full border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100";
const buttonClass =
  "inline-flex h-10 items-center justify-center border border-stone-300 bg-white px-4 text-sm font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900";

const GENDER_LABELS: Record<GenderOption, string> = {
  woman: "Woman",
  man: "Man",
  non_binary: "Non-binary",
  prefer_not_to_say: "Prefer not to say",
  custom: "Custom",
};

const ORIENTATION_LABELS: Record<SexualOrientationOption, string> = {
  straight: "Straight",
  gay: "Gay",
  lesbian: "Lesbian",
  bisexual: "Bisexual",
  pansexual: "Pansexual",
  asexual: "Asexual",
  queer: "Queer",
  prefer_not_to_say: "Prefer not to say",
  custom: "Custom",
};

const COUNTRY_OPTIONS = [
  { code: "", label: "Prefer not to say" },
  { code: "US", label: "United States" },
  { code: "CA", label: "Canada" },
  { code: "GB", label: "United Kingdom" },
  { code: "AU", label: "Australia" },
  { code: "DE", label: "Germany" },
  { code: "FR", label: "France" },
  { code: "IN", label: "India" },
  { code: "JP", label: "Japan" },
  { code: "BR", label: "Brazil" },
] as const;

type BirthMode = "none" | "year" | "full";

function birthModeOf(data: UserDemographics): BirthMode {
  if (data.birthDate) return "full";
  if (data.birthYear) return "year";
  return "none";
}

const emptyDemographics = (): UserDemographics => ({
  optedIn: false,
  birthYear: null,
  birthDate: null,
  gender: null,
  genderCustom: null,
  sexualOrientation: null,
  sexualOrientationCustom: null,
  countryCode: null,
});

export function DemographicsPanel() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;

  const [form, setForm] = useState<UserDemographics>(emptyDemographics);
  const [birthMode, setBirthMode] = useState<BirthMode>("none");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getDemographics()
      .then((data) => {
        if (cancelled) return;
        setForm(data);
        setBirthMode(birthModeOf(data));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load demographics.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  function updateField<K extends keyof UserDemographics>(key: K, value: UserDemographics[K]) {
    setSaved(false);
    setError(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function onBirthModeChange(mode: BirthMode) {
    setBirthMode(mode);
    setSaved(false);
    setError(null);
    setForm((prev) => {
      if (mode === "none") return { ...prev, birthYear: null, birthDate: null };
      if (mode === "year") return { ...prev, birthDate: null };
      return prev;
    });
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving || !user) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const payload: UserDemographics = {
        ...form,
        birthYear: birthMode === "none" ? null : form.birthYear,
        birthDate: birthMode === "full" ? form.birthDate : null,
      };
      const savedData = await updateDemographics(payload);
      setForm(savedData);
      setBirthMode(birthModeOf(savedData));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save demographics.");
    } finally {
      setSaving(false);
    }
  }

  if (isPending || loading) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (!user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account/profile" className="underline">
          sign in
        </Link>{" "}
        to manage demographics.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {saved && <p className="text-sm text-green-700 dark:text-green-400">Demographics saved.</p>}

      <div className="border border-stone-200 p-5 dark:border-stone-800">
        <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Demographics</h2>
        <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">
          Optional, opt-in details used only for high-level aggregate insights — for example,
          &ldquo;Millennials answered this way 90% of the time.&rdquo; Nothing here is shown on your
          public profile.
        </p>

        <label className="mt-4 flex items-start gap-3">
          <input
            type="checkbox"
            checked={form.optedIn}
            onChange={(e) => updateField("optedIn", e.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 accent-stone-800 dark:accent-stone-200"
          />
          <span className="text-sm text-stone-700 dark:text-stone-200">
            Share my demographics for aggregate insights
          </span>
        </label>
      </div>

      <fieldset
        disabled={!form.optedIn}
        className="space-y-4 border border-stone-200 p-5 disabled:opacity-60 dark:border-stone-800"
      >
        <legend className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          Your details
        </legend>

        <div>
          <p className={labelClass}>Date of birth</p>
          <div className="mt-2 flex flex-wrap gap-4 text-sm text-stone-700 dark:text-stone-200">
            {(
              [
                ["none", "Prefer not to say"],
                ["year", "Year only"],
                ["full", "Full date"],
              ] as const
            ).map(([mode, text]) => (
              <label key={mode} className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name="birth-mode"
                  checked={birthMode === mode}
                  onChange={() => onBirthModeChange(mode)}
                />
                {text}
              </label>
            ))}
          </div>
          {birthMode === "year" && (
            <input
              type="number"
              min={1900}
              max={new Date().getFullYear()}
              value={form.birthYear ?? ""}
              onChange={(e) =>
                updateField("birthYear", e.target.value ? Number(e.target.value) : null)
              }
              placeholder="1990"
              className={`${inputClass} mt-3 max-w-[10rem]`}
            />
          )}
          {birthMode === "full" && (
            <input
              type="date"
              value={form.birthDate ?? ""}
              onChange={(e) => {
                const value = e.target.value || null;
                updateField("birthDate", value);
                if (value) updateField("birthYear", Number(value.slice(0, 4)));
              }}
              className={`${inputClass} mt-3 max-w-[14rem]`}
            />
          )}
        </div>

        <div>
          <label htmlFor="gender" className={labelClass}>
            Gender
          </label>
          <select
            id="gender"
            value={form.gender ?? ""}
            onChange={(e) => updateField("gender", (e.target.value || null) as GenderOption | null)}
            className={inputClass}
          >
            <option value="">Prefer not to say</option>
            {GENDER_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {GENDER_LABELS[value]}
              </option>
            ))}
          </select>
          {form.gender === "custom" && (
            <input
              type="text"
              value={form.genderCustom ?? ""}
              onChange={(e) => updateField("genderCustom", e.target.value || null)}
              placeholder="How you identify"
              maxLength={100}
              className={`${inputClass} mt-2`}
            />
          )}
        </div>

        <div>
          <label htmlFor="sexual-orientation" className={labelClass}>
            Sexual orientation
          </label>
          <select
            id="sexual-orientation"
            value={form.sexualOrientation ?? ""}
            onChange={(e) =>
              updateField(
                "sexualOrientation",
                (e.target.value || null) as SexualOrientationOption | null,
              )
            }
            className={inputClass}
          >
            <option value="">Prefer not to say</option>
            {SEXUAL_ORIENTATION_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {ORIENTATION_LABELS[value]}
              </option>
            ))}
          </select>
          {form.sexualOrientation === "custom" && (
            <input
              type="text"
              value={form.sexualOrientationCustom ?? ""}
              onChange={(e) => updateField("sexualOrientationCustom", e.target.value || null)}
              placeholder="How you identify"
              maxLength={100}
              className={`${inputClass} mt-2`}
            />
          )}
        </div>

        <div>
          <label htmlFor="country" className={labelClass}>
            Country or region
          </label>
          <select
            id="country"
            value={form.countryCode ?? ""}
            onChange={(e) => updateField("countryCode", e.target.value || null)}
            className={inputClass}
          >
            {COUNTRY_OPTIONS.map(({ code, label }) => (
              <option key={code || "none"} value={code}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </fieldset>

      <button type="submit" disabled={saving} className={buttonClass}>
        {saving ? "Saving…" : "Save demographics"}
      </button>
    </form>
  );
}
