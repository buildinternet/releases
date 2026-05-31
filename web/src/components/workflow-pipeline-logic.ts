import type { WorkflowStage, LastRun, AiPass, RunStatus } from "./use-source-workflow";

export type Dot = "ok" | "err" | "neutral" | "async";

const fmtAi = (ai: { count: number; inputTokens: number; outputTokens: number }) =>
  `${ai.count}x · ${ai.inputTokens + ai.outputTokens} tok`;

export interface StageView extends WorkflowStage {
  dot: Dot;
  detail: string; // sub-label under the name
  outcome: string; // right-aligned outcome/counts
}
export interface PipelineView {
  content: StageView[];
  async: StageView[];
}

/** Candidate stage keys a usage_log operation can light. A given source's
 *  topology contains at most one of the candidates, so returning several is safe.
 *  Order of checks matters: "enrich-extract" must hit enrich before extract. */
export function operationToStageKeys(op: string): string[] {
  const o = op.toLowerCase();
  if (o.includes("summarize") || o === "compare") return ["summarize"];
  if (o.includes("enrich")) return ["enrich"];
  // agent-ingest is the scrape/crawl/agent extraction label — light whichever
  // node the source's topology actually has.
  if (o.includes("agent")) return ["agent-session", "extract"];
  if (o.includes("extract")) return ["extract"]; // firecrawl-extract, extract, extract-toolloop
  if (o.includes("classify")) return ["classify"];
  return [];
}

function dotForRun(status: RunStatus | undefined): Dot {
  if (status === "success") return "ok";
  if (status === "error") return "err";
  return "neutral"; // no_change | dry_run | undefined
}

export function derivePipelineView(
  stages: WorkflowStage[],
  lastRun: LastRun | null,
  aiPasses: AiPass[],
): PipelineView {
  const ran = new Map<string, { count: number; inputTokens: number; outputTokens: number }>();
  for (const p of aiPasses) {
    for (const k of operationToStageKeys(p.operation)) {
      const prev = ran.get(k);
      ran.set(k, {
        count: (prev?.count ?? 0) + p.count,
        inputTokens: (prev?.inputTokens ?? 0) + p.inputTokens,
        outputTokens: (prev?.outputTokens ?? 0) + p.outputTokens,
      });
    }
  }
  const noChange = lastRun?.status === "no_change";

  const view: StageView[] = stages.map((s) => {
    const detail = s.detailHint ?? "";
    if (s.kind === "async") {
      // Embed/changelog/publish have no per-run D1 record; show best-effort.
      const ai = ran.get(s.key);
      if (ai)
        return {
          ...s,
          dot: "ok" as Dot,
          detail,
          outcome: fmtAi(ai),
        };
      return { ...s, dot: lastRun ? "async" : "neutral", detail, outcome: lastRun ? "fired" : "—" };
    }
    if (s.key === "hash") {
      return {
        ...s,
        dot: dotForRun(lastRun?.status),
        detail,
        outcome: lastRun ? (noChange ? "unchanged" : "changed") : "—",
      };
    }
    if (s.key === "upsert") {
      return {
        ...s,
        dot: dotForRun(lastRun?.status),
        detail,
        outcome: lastRun ? `found ${lastRun.releasesFound} · +${lastRun.releasesInserted}` : "—",
      };
    }
    if (s.kind === "ai") {
      const ai = ran.get(s.key);
      if (ai)
        return {
          ...s,
          dot: "ok" as Dot,
          detail,
          outcome: fmtAi(ai),
        };
      // classify has no usage_log label — show it as configured, not "ran".
      // On error the stage may not have run at all; show "—" rather than "ran".
      const fallbackOutcome =
        s.key === "classify" ? "configured" : lastRun?.status === "error" ? "—" : "ran";
      return {
        ...s,
        dot: "neutral",
        detail,
        outcome: lastRun ? fallbackOutcome : "—",
      };
    }
    // remaining sync nodes: poll/webhook/fetch/crawl/parse/diff
    return {
      ...s,
      dot: dotForRun(lastRun?.status),
      detail,
      outcome: lastRun ? (s.key === "fetch" ? "ok" : "") : "—",
    };
  });

  return {
    content: view.filter((v) => v.kind !== "async"),
    async: view.filter((v) => v.kind === "async"),
  };
}
