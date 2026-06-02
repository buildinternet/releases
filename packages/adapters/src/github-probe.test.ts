import { afterEach, expect, it } from "bun:test";
import { probeRepo } from "./github-probe.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

it("captures stargazers_count from the repo response", async () => {
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    if (url.endsWith("/repos/acme/widget")) {
      return new Response(
        JSON.stringify({
          archived: false,
          default_branch: "main",
          name: "widget",
          owner: { login: "acme" },
          stargazers_count: 4321,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/releases")) return new Response("[]", { status: 200 });
    return new Response("", { status: 404 }); // CHANGELOG.md absent
  }) as unknown as typeof fetch;

  const result = await probeRepo({ GITHUB_TOKEN: "t" }, "acme", "widget");
  expect(result.exists).toBe(true);
  expect(result.stargazersCount).toBe(4321);
});
