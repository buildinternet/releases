import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppPlatformCue } from "./app-platform-cue.tsx";

describe("AppPlatformCue", () => {
  it("renders the iOS cue with an accessible label", () => {
    const html = renderToStaticMarkup(<AppPlatformCue label="iOS" />);
    expect(html).toContain("iOS app");
    expect(html).toContain('aria-label="Available for iOS"');
  });

  it("renders the macOS cue with an accessible label", () => {
    const html = renderToStaticMarkup(<AppPlatformCue label="macOS" />);
    expect(html).toContain("macOS app");
    expect(html).toContain('aria-label="Available for macOS"');
  });

  it("applies an extra className", () => {
    const html = renderToStaticMarkup(<AppPlatformCue label="iOS" className="text-[13px]" />);
    expect(html).toContain("text-[13px]");
  });
});
