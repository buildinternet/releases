/**
 * Body parser for `POST /v1/workflows/overview-regen`.
 *
 * An omitted org list used to mean "every eligible org". That made `{}` start
 * a real, billed sweep. The daily cron does not use this parser — it creates
 * the workflow with `trigger: "cron"` and no org list — so requiring an
 * explicit scope here does not change the schedule.
 */

export interface OverviewRegenRequest {
  /** Set when the caller named orgs. Absent means a full eligible sweep (`all: true`). */
  orgs?: string[];
  dryRun: boolean;
  maxOrgs?: number;
  force: boolean;
}

export function parseOverviewRegenBody(
  body: unknown,
): { ok: true; value: OverviewRegenRequest } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Body must be a JSON object" };
  }
  const raw = body as {
    orgs?: unknown;
    all?: unknown;
    dryRun?: unknown;
    maxOrgs?: unknown;
    force?: unknown;
  };

  let orgs: string[] | undefined;
  if (raw.orgs !== undefined) {
    if (!Array.isArray(raw.orgs)) {
      return { ok: false, message: "`orgs` must be an array of strings" };
    }
    orgs = raw.orgs
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (orgs.length === 0) {
      return { ok: false, message: "`orgs` must contain at least one non-empty string" };
    }
  }

  const all = raw.all === true;
  const force = raw.force === true;
  if (force && !orgs) {
    return { ok: false, message: "`force` requires a non-empty `orgs` list" };
  }
  if (!orgs && !all) {
    return {
      ok: false,
      message: "Provide a non-empty `orgs` list or `all: true` to sweep every eligible org",
    };
  }

  const maxOrgs = typeof raw.maxOrgs === "number" && raw.maxOrgs > 0 ? raw.maxOrgs : undefined;
  return {
    ok: true,
    value: { orgs, dryRun: raw.dryRun === true, maxOrgs, force },
  };
}
