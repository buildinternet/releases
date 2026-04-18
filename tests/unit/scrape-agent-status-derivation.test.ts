import { describe, it, expect } from "bun:test";
import { deriveSweepStatus } from "../../workers/api/src/cron/scrape-agent-sweep";

describe("deriveSweepStatus", () => {
  it("returns done with zero-candidate note when candidates=0", () => {
    const out = deriveSweepStatus({ candidates: 0, dispatchResults: [] });
    expect(out.status).toBe("done");
    expect(out.notes).toBe("no flagged sources");
  });

  it("returns done when all dispatches succeeded", () => {
    const out = deriveSweepStatus({
      candidates: 3,
      dispatchResults: [
        { orgSlug: "a", ok: true, sessionId: "ma-1" },
        { orgSlug: "b", ok: true, sessionId: "ma-2" },
        { orgSlug: "c", ok: true, sessionId: "ma-3" },
      ],
    });
    expect(out.status).toBe("done");
    expect(out.abortReason).toBeUndefined();
  });

  it("returns degraded when some dispatches failed", () => {
    const out = deriveSweepStatus({
      candidates: 3,
      dispatchResults: [
        { orgSlug: "a", ok: true, sessionId: "ma-1" },
        { orgSlug: "b", ok: false, error: "500 boom" },
      ],
    });
    expect(out.status).toBe("degraded");
  });

  it("returns dispatch_failed when all dispatches failed", () => {
    const out = deriveSweepStatus({
      candidates: 2,
      dispatchResults: [
        { orgSlug: "a", ok: false, error: "500 boom" },
        { orgSlug: "b", ok: false, error: "timeout" },
      ],
    });
    expect(out.status).toBe("dispatch_failed");
  });

  it("propagates an aborted preflight regardless of dispatch results", () => {
    const out = deriveSweepStatus({
      candidates: 0,
      dispatchResults: [],
      abortedPreflight: { action: "abort", abortReason: "anthropic_auth" },
    });
    expect(out.status).toBe("aborted");
    expect(out.abortReason).toBe("anthropic_auth");
  });
});
