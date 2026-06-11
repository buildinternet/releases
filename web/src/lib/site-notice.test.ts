import { describe, expect, it } from "bun:test";
import { selectNoticeForSlot } from "./site-notice";
import type { StoredSiteNotice } from "@buildinternet/releases-core/site-notice";

const base: StoredSiteNotice = {
  active: true,
  message: "Hi",
  placement: "banner",
  color: "#0081e7",
  dismissible: false,
  updatedAt: "2026-06-11T00:00:00.000Z",
};

describe("selectNoticeForSlot", () => {
  it("returns the notice when placement matches the slot", () => {
    expect(selectNoticeForSlot(base, "banner")).toEqual(base);
    expect(selectNoticeForSlot({ ...base, placement: "home" }, "home")?.message).toBe("Hi");
  });
  it("returns null when placement does not match the slot", () => {
    expect(selectNoticeForSlot(base, "home")).toBeNull();
    expect(selectNoticeForSlot({ ...base, placement: "home" }, "banner")).toBeNull();
  });
  it("returns null for an inactive or missing notice", () => {
    expect(selectNoticeForSlot({ ...base, active: false }, "banner")).toBeNull();
    expect(selectNoticeForSlot(null, "banner")).toBeNull();
  });
});
