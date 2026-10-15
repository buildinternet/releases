import { afterEach, describe, expect, test } from "bun:test";
import { setIssueContext } from "./issue-context";

type Span = { setAttribute(key: string, value: string): void };

const spanGlobal = globalThis as { __ISSUE_SPAN__?: Span | null };

afterEach(() => {
  spanGlobal.__ISSUE_SPAN__ = undefined;
});

function capture(): { span: Span; attrs: Record<string, string> } {
  const attrs: Record<string, string> = {};
  const span: Span = {
    setAttribute(key, value) {
      attrs[key] = value;
    },
  };
  spanGlobal.__ISSUE_SPAN__ = span;
  return { span, attrs };
}

describe("setIssueContext", () => {
  test("sets user, account, and session ids on the active span", () => {
    const { attrs } = capture();
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
    const { attrs } = capture();
    setIssueContext({
      "user.id": "person@example.com",
      "account.id": "relk_lookup_secret",
      "session.id": "  ",
    });
    expect(attrs).toEqual({});
  });

  test("does nothing when there is no active span", () => {
    expect(() => setIssueContext({ "user.id": "user_123" })).not.toThrow();
  });
});
