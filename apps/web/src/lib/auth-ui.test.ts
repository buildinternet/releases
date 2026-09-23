import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { authOriginSupport } from "./auth-ui.js";

const ORIG_AUTH_URL = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
const ORIG_WINDOW = (globalThis as { window?: unknown }).window;

function setWindow(hostname: string | undefined) {
  if (hostname === undefined) {
    delete (globalThis as { window?: unknown }).window;
    return;
  }
  (globalThis as { window?: unknown }).window = { location: { hostname } };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.releases.sh";
});

afterEach(() => {
  if (ORIG_AUTH_URL === undefined) delete process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  else process.env.NEXT_PUBLIC_BETTER_AUTH_URL = ORIG_AUTH_URL;
  if (ORIG_WINDOW === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = ORIG_WINDOW;
});

describe("authOriginSupport", () => {
  it("supports the canonical apex origin", () => {
    setWindow("releases.sh");
    expect(authOriginSupport()).toEqual({ supported: true });
  });

  it("supports any subdomain of the cookie base", () => {
    setWindow("www.releases.sh");
    expect(authOriginSupport()).toEqual({ supported: true });
  });

  it("flags a Vercel branch/preview origin and points at the canonical site", () => {
    setWindow("releases-7cpb2spwz-buildinternet.vercel.app");
    expect(authOriginSupport()).toEqual({
      supported: false,
      canonicalOrigin: "https://releases.sh",
    });
  });

  it("works for the localhost auth family too", () => {
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.releases.localhost";
    setWindow("feat-x.releases.localhost");
    expect(authOriginSupport()).toEqual({ supported: true });
    setWindow("localhost");
    expect(authOriginSupport()).toEqual({
      supported: false,
      canonicalOrigin: "https://releases.localhost",
    });
  });

  it("fails open when auth URL is unset", () => {
    delete process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
    setWindow("anything.vercel.app");
    expect(authOriginSupport()).toEqual({ supported: true });
  });

  it("fails open under SSR (no window)", () => {
    setWindow(undefined);
    expect(authOriginSupport()).toEqual({ supported: true });
  });

  it("fails open when the cookie base would be a bare TLD-less host", () => {
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.localhost";
    setWindow("preview.example.com");
    expect(authOriginSupport()).toEqual({ supported: true });
  });
});
