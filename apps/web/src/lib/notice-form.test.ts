import { describe, it, expect } from "bun:test";
import {
  buildNoticeFromDraft,
  draftFromNotice,
  emptyNoticeDraft,
  isAbsoluteHttpUrl,
  type NoticeDraft,
} from "./notice-form";

const base: NoticeDraft = {
  message: "Heads up",
  linkText: "",
  linkMode: "internal",
  linkValue: "",
};

describe("buildNoticeFromDraft", () => {
  it("builds a message-only notice", () => {
    expect(buildNoticeFromDraft(base)).toEqual({ notice: { message: "Heads up" } });
  });

  it("trims the message", () => {
    expect(buildNoticeFromDraft({ ...base, message: "  Hi  " })).toEqual({
      notice: { message: "Hi" },
    });
  });

  it("rejects an empty / whitespace-only message", () => {
    expect("error" in buildNoticeFromDraft({ ...base, message: "   " })).toBe(true);
  });

  it("rejects an over-long message", () => {
    expect("error" in buildNoticeFromDraft({ ...base, message: "x".repeat(281) })).toBe(true);
  });

  it("attaches an internal coordinate + link label", () => {
    expect(
      buildNoticeFromDraft({
        ...base,
        linkMode: "internal",
        linkValue: "cognition/devin",
        linkText: "View Devin",
      }),
    ).toEqual({
      notice: { message: "Heads up", coordinate: "cognition/devin", linkText: "View Devin" },
    });
  });

  it("trims the coordinate", () => {
    expect(buildNoticeFromDraft({ ...base, linkValue: "  windsurf  " })).toEqual({
      notice: { message: "Heads up", coordinate: "windsurf" },
    });
  });

  it("rejects a malformed coordinate", () => {
    expect(
      "error" in buildNoticeFromDraft({ ...base, linkMode: "internal", linkValue: "a/b/c" }),
    ).toBe(true);
    expect(
      "error" in buildNoticeFromDraft({ ...base, linkMode: "internal", linkValue: "/leading" }),
    ).toBe(true);
  });

  it("attaches an external href", () => {
    expect(
      buildNoticeFromDraft({ ...base, linkMode: "external", linkValue: "https://devin.ai" }),
    ).toEqual({ notice: { message: "Heads up", href: "https://devin.ai" } });
  });

  it("rejects a non-http(s) or malformed href", () => {
    expect(
      "error" in buildNoticeFromDraft({ ...base, linkMode: "external", linkValue: "ftp://x" }),
    ).toBe(true);
    expect(
      "error" in buildNoticeFromDraft({ ...base, linkMode: "external", linkValue: "not a url" }),
    ).toBe(true);
  });

  it("omits the link label when there is no link target", () => {
    expect(buildNoticeFromDraft({ ...base, linkText: "orphan label" })).toEqual({
      notice: { message: "Heads up" },
    });
  });

  it("sends only the active mode's target, never both", () => {
    const internal = buildNoticeFromDraft({ ...base, linkMode: "internal", linkValue: "windsurf" });
    expect("notice" in internal && internal.notice.href).toBeUndefined();
    const external = buildNoticeFromDraft({
      ...base,
      linkMode: "external",
      linkValue: "https://x.com",
    });
    expect("notice" in external && external.notice.coordinate).toBeUndefined();
  });
});

describe("draftFromNotice", () => {
  it("returns an empty draft for null / undefined", () => {
    expect(draftFromNotice(null)).toEqual(emptyNoticeDraft());
    expect(draftFromNotice(undefined)).toEqual(emptyNoticeDraft());
  });

  it("maps a coordinate notice to internal mode", () => {
    expect(draftFromNotice({ message: "M", coordinate: "a/b", linkText: "L" })).toEqual({
      message: "M",
      linkText: "L",
      linkMode: "internal",
      linkValue: "a/b",
    });
  });

  it("maps an href notice to external mode", () => {
    expect(draftFromNotice({ message: "M", href: "https://x.com" })).toEqual({
      message: "M",
      linkText: "",
      linkMode: "external",
      linkValue: "https://x.com",
    });
  });
});

describe("isAbsoluteHttpUrl", () => {
  it("accepts http and https", () => {
    expect(isAbsoluteHttpUrl("https://x.com")).toBe(true);
    expect(isAbsoluteHttpUrl("http://x.com/path?q=1")).toBe(true);
  });

  it("rejects other schemes and garbage", () => {
    expect(isAbsoluteHttpUrl("ftp://x")).toBe(false);
    expect(isAbsoluteHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isAbsoluteHttpUrl("/relative")).toBe(false);
    expect(isAbsoluteHttpUrl("")).toBe(false);
  });
});
