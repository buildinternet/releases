import { describe, expect, it } from "bun:test";
import type { NoulBatchModel, NoulBatchRequest } from "./decision-model";
import {
  SEMANTIC_ALERT_CONTENT_CHARS,
  SEMANTIC_ALERT_QUESTIONS_PER_CALL,
  buildSemanticAlertQuestion,
  buildSemanticAlertState,
  chunkSemanticAlerts,
  matchSemanticAlerts,
  semanticAlertMatches,
  type SemanticAlertCandidate,
} from "./semantic-alert-match";

const QUERY = "Slack integrations with B2B software";

function alert(id: string, threshold = 0.8): SemanticAlertCandidate {
  return { id, query: `${QUERY} ${id}`, threshold };
}

function model(
  probabilities: Record<string, number | undefined>,
  calls: NoulBatchRequest[] = [],
): NoulBatchModel {
  return {
    id: "openrouter:typesafe/jev-1.13",
    decideNoul: async (request) => {
      calls.push(request);
      return {
        answers: request.questions.map((question) => {
          const probability = probabilities[question.id];
          return {
            id: question.id,
            ...(probability !== undefined ? { probability } : {}),
          };
        }),
        usage: { inputTokens: 20, outputTokens: 4, costUsd: 0.00002 },
      };
    },
  };
}

describe("semantic alert state", () => {
  it("caps content like the marketing classifier and omits alert text", () => {
    const state = buildSemanticAlertState({
      sourceName: "Acme Blog",
      title: "Slack for finance teams",
      url: "https://example.com/slack",
      summary: "A short summary",
      content: "y".repeat(SEMANTIC_ALERT_CONTENT_CHARS + 5),
    });
    expect(state).toContain("Source: Acme Blog");
    expect(state).toContain("Title: Slack for finance teams");
    expect(state).toContain("URL: https://example.com/slack");
    expect(state).toContain("Summary:\nA short summary");
    expect(state).toContain(`${"y".repeat(SEMANTIC_ALERT_CONTENT_CHARS)}\n\n[truncated]`);
    expect(state).not.toContain(QUERY);
  });

  it("encodes the freeform query only as the noul true criterion", () => {
    const question = buildSemanticAlertQuestion({ id: "sal_a", query: QUERY });
    expect(question.criteria.true).toBe(QUERY);
    expect(question.criteria.false.length).toBeGreaterThan(0);
    expect(question.instructions).not.toContain(QUERY);
  });
});

describe("semantic alert batching and threshold", () => {
  it("chunks at the default question cap", () => {
    const alerts = Array.from({ length: SEMANTIC_ALERT_QUESTIONS_PER_CALL + 1 }, (_, i) => i);
    expect(chunkSemanticAlerts(alerts).map((chunk) => chunk.length)).toEqual([
      SEMANTIC_ALERT_QUESTIONS_PER_CALL,
      1,
    ]);
  });

  it("matches at the stored threshold and not below it", () => {
    expect(semanticAlertMatches(0.8, 0.8)).toBe(true);
    expect(semanticAlertMatches(1, 0.8)).toBe(true);
    expect(semanticAlertMatches(0.799999, 0.8)).toBe(false);
    expect(semanticAlertMatches(0.95, 0.99)).toBe(false);
  });

  for (const probability of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.01]) {
    it(`does not match probability ${String(probability)}`, () => {
      expect(semanticAlertMatches(probability, 0.8)).toBe(false);
    });
  }

  it("sends one noul question per alert on a shared state and honors the cap", async () => {
    const calls: NoulBatchRequest[] = [];
    const alerts = [alert("sal_a", 0.8), alert("sal_b", 0.9), alert("sal_c", 0.8)];
    const outcome = await matchSemanticAlerts(
      model({ sal_a: 0.8, sal_b: 0.85, sal_c: 0.2 }, calls),
      "Source: Acme\nTitle: Slack",
      alerts,
      { questionsPerCall: 2 },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.questions.map((question) => question.id)).toEqual(["sal_a", "sal_b"]);
    expect(calls[1]!.questions.map((question) => question.id)).toEqual(["sal_c"]);
    expect(calls[0]!.state).toBe(calls[1]!.state);
    expect(calls[0]!.state).not.toContain(QUERY);
    expect(calls[0]!.questions[0]!.criteria.true).toContain(QUERY);
    expect(outcome.decisions).toEqual([
      { alertId: "sal_a", probability: 0.8, matched: true, disposition: "matched" },
      { alertId: "sal_b", probability: 0.85, matched: false, disposition: "below_threshold" },
      { alertId: "sal_c", probability: 0.2, matched: false, disposition: "below_threshold" },
    ]);
    expect(outcome.calls.map((call) => call.questionCount)).toEqual([2, 1]);
  });

  it("fails a thrown chunk closed without a second call for those alerts", async () => {
    const seen: string[][] = [];
    const flaky: NoulBatchModel = {
      id: "test",
      decideNoul: async (request) => {
        seen.push(request.questions.map((question) => question.id));
        if (request.questions.some((question) => question.id === "sal_b")) {
          throw new Error(QUERY);
        }
        return {
          answers: request.questions.map((question) => ({ id: question.id, probability: 0.99 })),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const outcome = await matchSemanticAlerts(
      flaky,
      "Title: ok",
      [alert("sal_a"), alert("sal_b"), alert("sal_c")],
      { questionsPerCall: 1 },
    );
    expect(seen).toEqual([["sal_a"], ["sal_b"], ["sal_c"]]);
    expect(outcome.decisions).toEqual([
      { alertId: "sal_a", probability: 0.99, matched: true, disposition: "matched" },
      {
        alertId: "sal_b",
        disposition: "failed",
        matched: false,
        failureCategory: "provider_error",
      },
      { alertId: "sal_c", probability: 0.99, matched: true, disposition: "matched" },
    ]);
    expect(outcome.calls).toHaveLength(2);
  });

  it("fails closed when the provider omits a probability", async () => {
    const outcome = await matchSemanticAlerts(model({ sal_a: undefined }), "Title: ok", [
      alert("sal_a"),
    ]);
    expect(outcome.decisions).toEqual([
      {
        alertId: "sal_a",
        disposition: "failed",
        matched: false,
        failureCategory: "invalid_probability",
      },
    ]);
  });

  it("does not call the model when there are no candidates", async () => {
    let called = false;
    const outcome = await matchSemanticAlerts(
      {
        id: "test",
        decideNoul: async () => {
          called = true;
          return { answers: [], usage: {} };
        },
      },
      "Title: ok",
      [],
    );
    expect(called).toBe(false);
    expect(outcome).toEqual({ decisions: [], calls: [] });
  });
});
