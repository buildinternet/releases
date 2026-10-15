import { afterEach, describe, expect, test } from "bun:test";
import { bindIssueTracing, setIssueContext } from "./issue-context";

afterEach(() => {
  bindIssueTracing(undefined);
});

function capture(): Record<string, string> {
  const attrs: Record<string, string> = {};
  bindIssueTracing({
    tracing: {
      getActiveSpan: () => ({
        setAttribute(key, value) {
          attrs[key] = value;
        },
      }),
    },
  });
  return attrs;
}

describe("setIssueContext", () => {
  test("sets user, account, and session ids on the active span", () => {
    const attrs = capture();
    setIssueContext({
      "user.id": "user_123",
      "account.id": "ws_456",
      "session.id": "sess_789",
    });
    expect(attrs).toEqual({
      "user.id": "user_123",
      "account.id": "ws_456",
      "session.id": "sess_789",
    });
  });

  test("skips emails, tokens, and blank values", () => {
    const attrs = capture();
    setIssueContext({
      "user.id": "person@example.com",
      "account.id": "relk_lookup_secret",
      "session.id": "  ",
    });
    expect(attrs).toEqual({});
  });

  test("does nothing when there is no active span", () => {
    bindIssueTracing({ tracing: { getActiveSpan: () => undefined } });
    expect(() => setIssueContext({ "user.id": "user_123" })).not.toThrow();
  });

  test("does nothing when tracing is not bound", () => {
    expect(() => setIssueContext({ "user.id": "user_123" })).not.toThrow();
  });
});
