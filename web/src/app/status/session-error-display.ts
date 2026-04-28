/**
 * Pure helpers for rendering session-error classification on the Sessions tab.
 * Splits provider-side incidents (managed-agents service errors) from our-side
 * failures (parser, no-tools, timeout) so the dashboard signals where to look.
 */

export interface ClassifiedSession {
  status: "running" | "complete" | "error" | "cancelled";
  startedAt: number;
  error?: string;
  errorSource?: "provider" | "us";
  errorType?: string;
  stopReason?: string;
  retryCount?: number;
}

export interface ErrorDisplay {
  /** Visible label in the Result column. */
  label: string;
  /** Tooltip / longer hover text. */
  tooltip: string;
  /** Tailwind text-color class — distinct hue for provider vs us. */
  tone: "amber" | "red";
}

/**
 * Build the Result-column display for an errored session. Returns null for
 * non-error states; the caller renders its own success/running variant.
 *
 * Provider-side errors get amber + `managed-agents · <type>` framing; our-side
 * keeps the existing red treatment so triage at a glance stays accurate.
 */
export function formatSessionError(session: ClassifiedSession): ErrorDisplay | null {
  if (session.status !== "error") return null;
  const error = session.error ?? "Session error";

  if (session.errorSource === "provider") {
    const typeNote = session.errorType ? ` · ${session.errorType}` : "";
    const exhausted = session.stopReason === "retries_exhausted";
    const retryNote =
      exhausted && session.retryCount !== undefined ? ` · ${session.retryCount} retries` : "";
    const headline = exhausted
      ? `managed-agents · retries exhausted${typeNote}`
      : `managed-agents${typeNote}`;
    return {
      label: headline,
      tooltip: `${headline}${retryNote}\n${error}`,
      tone: "amber",
    };
  }

  return { label: error, tooltip: error, tone: "red" };
}

/**
 * A burst of provider-side `session.error` rows in a tight time window
 * usually means upstream is down. Roll them up into a single banner so the
 * dashboard reads as "Anthropic incident" instead of N independent red rows.
 */
export interface IncidentGroup {
  errorType: string;
  count: number;
  startedAt: number;
  endedAt: number;
}

const INCIDENT_WINDOW_MS = 60_000;
const INCIDENT_MIN_SESSIONS = 3;

/**
 * Group provider-side errored sessions into incident clusters by `errorType`
 * within a 60s contiguous window. Sessions with no `errorType` are skipped.
 * Only returns groups with ≥ 3 sessions — anything smaller is just normal
 * variance and shouldn't be promoted to a banner.
 */
export function groupProviderIncidents(sessions: ClassifiedSession[]): IncidentGroup[] {
  const provider = sessions.filter(
    (s) => s.status === "error" && s.errorSource === "provider" && s.errorType,
  );
  if (provider.length === 0) return [];

  const byType = new Map<string, ClassifiedSession[]>();
  for (const s of provider) {
    const list = byType.get(s.errorType!) ?? [];
    list.push(s);
    byType.set(s.errorType!, list);
  }

  const groups: IncidentGroup[] = [];
  for (const [errorType, list] of byType) {
    list.sort((a, b) => a.startedAt - b.startedAt);
    let current: ClassifiedSession[] = [];
    for (const s of list) {
      if (
        current.length === 0 ||
        s.startedAt - current[current.length - 1].startedAt <= INCIDENT_WINDOW_MS
      ) {
        current.push(s);
      } else {
        if (current.length >= INCIDENT_MIN_SESSIONS) {
          groups.push(toGroup(errorType, current));
        }
        current = [s];
      }
    }
    if (current.length >= INCIDENT_MIN_SESSIONS) {
      groups.push(toGroup(errorType, current));
    }
  }

  groups.sort((a, b) => b.startedAt - a.startedAt);
  return groups;
}

function toGroup(errorType: string, sessions: ClassifiedSession[]): IncidentGroup {
  return {
    errorType,
    count: sessions.length,
    startedAt: sessions[0].startedAt,
    endedAt: sessions[sessions.length - 1].startedAt,
  };
}
