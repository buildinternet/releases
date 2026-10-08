import { describe, it, expect } from "bun:test";
import { browserCommand } from "../../src/lib/open-browser.js";

describe("browserCommand", () => {
  it("uses `open` on macOS", () => {
    expect(browserCommand("darwin", "https://x")).toEqual({ cmd: "open", args: ["https://x"] });
  });
  it("uses cmd/start on Windows", () => {
    expect(browserCommand("win32", "https://x")).toEqual({
      cmd: "cmd",
      args: ["/c", "start", "", "https://x"],
    });
  });
  it("uses xdg-open elsewhere", () => {
    expect(browserCommand("linux", "https://x")).toEqual({ cmd: "xdg-open", args: ["https://x"] });
  });
});
