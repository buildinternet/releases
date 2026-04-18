import { describe, it, expect } from "bun:test";
import { classifyPreflightResponse } from "../../workers/api/src/cron/scrape-agent-sweep";

describe("classifyPreflightResponse", () => {
  it("proceeds on 200", () => {
    expect(classifyPreflightResponse({ status: 200, body: "" })).toEqual({ action: "proceed" });
  });

  it("aborts on 401 with anthropic_auth", () => {
    expect(classifyPreflightResponse({ status: 401, body: "" })).toEqual({ action: "abort", abortReason: "anthropic_auth" });
  });

  it("aborts on 403 with anthropic_auth", () => {
    expect(classifyPreflightResponse({ status: 403, body: "" })).toEqual({ action: "abort", abortReason: "anthropic_auth" });
  });

  it("aborts on 402 with anthropic_credits", () => {
    expect(classifyPreflightResponse({ status: 402, body: "" })).toEqual({ action: "abort", abortReason: "anthropic_credits" });
  });

  it("aborts on 429 with credit_balance_too_low body", () => {
    const body = JSON.stringify({ error: { type: "credit_balance_too_low", message: "…" } });
    expect(classifyPreflightResponse({ status: 429, body })).toEqual({ action: "abort", abortReason: "anthropic_credits" });
  });

  it("warns (proceed) on 429 with unrelated body", () => {
    const body = JSON.stringify({ error: { type: "rate_limit_error" } });
    expect(classifyPreflightResponse({ status: 429, body })).toEqual({ action: "warn" });
  });

  it("warns (proceed) on 429 with non-JSON body", () => {
    expect(classifyPreflightResponse({ status: 429, body: "<html>…</html>" })).toEqual({ action: "warn" });
  });

  it("warns (proceed) on 5xx", () => {
    expect(classifyPreflightResponse({ status: 503, body: "" })).toEqual({ action: "warn" });
  });
});
