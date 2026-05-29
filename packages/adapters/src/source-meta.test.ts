import { describe, expect, test } from "bun:test";
import { isVideoFetched, videoSourceInfo } from "./source-meta";

const src = (over: Partial<{ type: string; metadata: string | null }>) =>
  ({ type: "video", metadata: null, ...over }) as any;

describe("isVideoFetched", () => {
  test("true only for type=video", () => {
    expect(isVideoFetched(src({ type: "video" }))).toBe(true);
    expect(isVideoFetched(src({ type: "feed" }))).toBe(false);
    expect(isVideoFetched(src({ type: "appstore" }))).toBe(false);
  });
});

describe("videoSourceInfo", () => {
  test("returns provider for video sources", () => {
    const meta = JSON.stringify({ video: { provider: "youtube" } });
    expect(videoSourceInfo("video", meta)).toEqual({ provider: "youtube" });
  });
  test("null for non-video type", () => {
    expect(videoSourceInfo("feed", JSON.stringify({ video: { provider: "youtube" } }))).toBeNull();
  });
  test("null when block missing or unparseable", () => {
    expect(videoSourceInfo("video", null)).toBeNull();
    expect(videoSourceInfo("video", "{not json")).toBeNull();
    expect(videoSourceInfo("video", JSON.stringify({}))).toBeNull();
  });
  test("null when provider is unrecognized or non-string", () => {
    expect(videoSourceInfo("video", JSON.stringify({ video: { provider: "twitch" } }))).toBeNull();
    expect(videoSourceInfo("video", JSON.stringify({ video: { provider: null } }))).toBeNull();
  });
});
