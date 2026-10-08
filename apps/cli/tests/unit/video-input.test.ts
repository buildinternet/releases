import { describe, it, expect } from "bun:test";
import { isVideoUrl } from "../../src/cli/commands/create-video.js";

describe("isVideoUrl", () => {
  it("matches youtube.com channel/playlist URLs with and without scheme", () => {
    expect(isVideoUrl("https://www.youtube.com/@AnthropicAI")).toBe(true);
    expect(isVideoUrl("www.youtube.com/@AnthropicAI")).toBe(true);
    expect(isVideoUrl("youtube.com/@AnthropicAI")).toBe(true);
    expect(
      isVideoUrl("https://www.youtube.com/playlist?list=PLf2m23nhTg1P_pl05on_Qbob_qx_Vw"),
    ).toBe(true);
  });

  it("matches youtube subdomains and the youtu.be short host", () => {
    expect(isVideoUrl("https://m.youtube.com/@AnthropicAI")).toBe(true);
    expect(isVideoUrl("https://music.youtube.com/channel/UC123")).toBe(true);
    expect(isVideoUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
  });

  it("rejects other hosts and look-alikes", () => {
    expect(isVideoUrl("https://example.com/watch")).toBe(false);
    expect(isVideoUrl("https://notyoutube.com/@x")).toBe(false);
    expect(isVideoUrl("https://youtube.com.evil.com/@x")).toBe(false);
    expect(isVideoUrl("https://vimeo.com/12345")).toBe(false);
  });

  it("rejects empty/blank input", () => {
    expect(isVideoUrl("")).toBe(false);
    expect(isVideoUrl("   ")).toBe(false);
  });
});
