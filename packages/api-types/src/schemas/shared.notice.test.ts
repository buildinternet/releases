import { describe, it, expect } from "bun:test";
import { NoticeSchema } from "./shared";

describe("NoticeSchema", () => {
  it("accepts a message-only notice", () => {
    expect(NoticeSchema.safeParse({ message: "Heads up" }).success).toBe(true);
  });
  it("accepts a message + internal coordinate", () => {
    expect(
      NoticeSchema.safeParse({
        message: "Moved",
        coordinate: "cognition/devin",
        linkText: "View Devin",
      }).success,
    ).toBe(true);
  });
  it("accepts a message + external href", () => {
    expect(NoticeSchema.safeParse({ message: "Moved", href: "https://devin.ai" }).success).toBe(
      true,
    );
  });
  it("rejects both coordinate and href", () => {
    expect(
      NoticeSchema.safeParse({ message: "x", coordinate: "a/b", href: "https://x.com" }).success,
    ).toBe(false);
  });
  it("rejects an empty message and an over-long message", () => {
    expect(NoticeSchema.safeParse({ message: "" }).success).toBe(false);
    expect(NoticeSchema.safeParse({ message: "x".repeat(281) }).success).toBe(false);
  });
  it("rejects a malformed coordinate", () => {
    expect(NoticeSchema.safeParse({ message: "x", coordinate: "/leading" }).success).toBe(false);
    expect(NoticeSchema.safeParse({ message: "x", coordinate: "a/b/c" }).success).toBe(false);
  });
});
