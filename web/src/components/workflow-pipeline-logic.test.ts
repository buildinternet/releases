import { describe, it, expect } from "bun:test";
import { operationToStageKeys, derivePipelineView } from "./workflow-pipeline-logic";
import type { WorkflowStage, LastRun, AiPass } from "./use-source-workflow";

describe("operationToStageKeys", () => {
  it("maps known labels, checking enrich before extract", () => {
    expect(operationToStageKeys("summarize")).toEqual(["summarize"]);
    expect(operationToStageKeys("compare")).toEqual(["summarize"]);
    expect(operationToStageKeys("enrich-extract")).toEqual(["enrich"]); // not "extract"
    expect(operationToStageKeys("firecrawl-extract")).toEqual(["extract"]);
    expect(operationToStageKeys("extract-toolloop")).toEqual(["extract"]);
    expect(operationToStageKeys("totally-unknown")).toEqual([]);
  });

  it("agent-ingest lights both agent-session and extract candidates", () => {
    const keys = operationToStageKeys("agent-ingest");
    expect(keys).toContain("extract");
    expect(keys).toContain("agent-session");
  });
});

describe("derivePipelineView", () => {
  const stages: WorkflowStage[] = [
    { key: "poll", label: "Poll", kind: "sync" },
    { key: "hash", label: "Hash check", kind: "sync" },
    { key: "extract", label: "Extract", kind: "ai" },
    { key: "upsert", label: "Upsert", kind: "sync" },
    { key: "embed", label: "Embed", kind: "async" },
  ];
  const lastRun: LastRun = {
    status: "success",
    releasesFound: 3,
    releasesInserted: 2,
    durationMs: 2400,
    error: null,
    createdAt: "2026-05-31T00:00:00Z",
  };
  const aiPasses: AiPass[] = [
    { operation: "firecrawl-extract", count: 1, inputTokens: 9, outputTokens: 4 },
  ];

  it("splits content vs async and derives outcomes", () => {
    const v = derivePipelineView(stages, lastRun, aiPasses);
    expect(v.content.map((s) => s.key)).toEqual(["poll", "hash", "extract", "upsert"]);
    expect(v.async.map((s) => s.key)).toEqual(["embed"]);
    expect(v.content.find((s) => s.key === "upsert")!.outcome).toBe("found 3 · +2");
    expect(v.content.find((s) => s.key === "extract")!.dot).toBe("ok"); // usage matched
    expect(v.async.find((s) => s.key === "embed")!.dot).toBe("async");
  });

  it("no_change run marks hash unchanged + neutral dots", () => {
    const nc: LastRun = { ...lastRun, status: "no_change", releasesFound: 0, releasesInserted: 0 };
    const v = derivePipelineView(stages, nc, []);
    expect(v.content.find((s) => s.key === "hash")!.outcome).toBe("unchanged");
    expect(v.content.find((s) => s.key === "poll")!.dot).toBe("neutral");
  });

  it("null lastRun -> all neutral, outcomes -", () => {
    const v = derivePipelineView(stages, null, []);
    expect(v.content.every((s) => s.dot === "neutral" || s.dot === "async")).toBe(true);
    expect(v.content.find((s) => s.key === "upsert")!.outcome).toBe("—");
  });

  it("agent-ingest lights extract node on scrape-style topology", () => {
    const scrapeStages: WorkflowStage[] = [
      { key: "fetch", label: "Fetch", kind: "sync" },
      { key: "hash", label: "Hash check", kind: "sync" },
      { key: "extract", label: "Extract", kind: "ai" },
      { key: "upsert", label: "Upsert", kind: "sync" },
    ];
    const agentPass: AiPass[] = [
      { operation: "agent-ingest", count: 2, inputTokens: 500, outputTokens: 100 },
    ];
    const v = derivePipelineView(scrapeStages, lastRun, agentPass);
    const extractStage = v.content.find((s) => s.key === "extract")!;
    expect(extractStage.dot).toBe("ok");
    expect(extractStage.outcome).toBe("2x · 600 tok");
  });

  it("error-status ai stage with no ran entry shows outcome '—'", () => {
    const errRun: LastRun = { ...lastRun, status: "error", releasesFound: 0, releasesInserted: 0 };
    const v = derivePipelineView(stages, errRun, []); // no aiPasses — extract never ran
    const extractStage = v.content.find((s) => s.key === "extract")!;
    expect(extractStage.outcome).toBe("—");
    expect(extractStage.dot).toBe("neutral");
  });
});
