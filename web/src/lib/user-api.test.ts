import { describe, it, expect, afterEach, beforeEach } from "bun:test";

const ORIG = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;

beforeEach(() => {
  process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.test/v1/";
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  else process.env.NEXT_PUBLIC_BETTER_AUTH_URL = ORIG;
});

describe("apiBase", () => {
  it("strips trailing slashes and a mistaken /v1 suffix", async () => {
    const { apiBase } = await import("./user-api.js");
    expect(apiBase()).toBe("https://api.test");
  });
});
