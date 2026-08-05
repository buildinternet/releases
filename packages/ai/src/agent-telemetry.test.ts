import { describe, expect, it } from "bun:test";
import { agentTelemetry, RELEASES_AGENT_ID } from "./agent-telemetry";

describe("agentTelemetry", () => {
  it("maps functionId and default agentId", () => {
    expect(agentTelemetry({ functionId: "marketing-classifier" })).toEqual({
      runtimeContext: { agentId: RELEASES_AGENT_ID },
      telemetry: {
        functionId: "marketing-classifier",
        includeRuntimeContext: { agentId: true },
      },
    });
  });

  it("prefers releaseId over sourceId for conversationId and emits both", () => {
    expect(
      agentTelemetry({
        functionId: "summarize-release",
        sourceId: "src_abc",
        releaseId: "rel_xyz",
      }),
    ).toEqual({
      runtimeContext: {
        agentId: RELEASES_AGENT_ID,
        conversationId: "rel_xyz",
        sourceId: "src_abc",
        releaseId: "rel_xyz",
      },
      telemetry: {
        functionId: "summarize-release",
        includeRuntimeContext: {
          agentId: true,
          conversationId: true,
          sourceId: true,
          releaseId: true,
        },
      },
    });
  });

  it("falls back conversationId to sourceId when no releaseId", () => {
    const t = agentTelemetry({ functionId: "extract-oneshot", sourceId: "src_only" });
    expect(t.runtimeContext.conversationId).toBe("src_only");
    expect(t.runtimeContext.sourceId).toBe("src_only");
  });

  it("honors an explicit conversationId", () => {
    const t = agentTelemetry({
      functionId: "org-overview",
      conversationId: "acme",
      sourceId: "src_ignored_for_conversation",
    });
    expect(t.runtimeContext.conversationId).toBe("acme");
  });
});
