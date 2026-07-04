import { describe, it, expect } from "bun:test";
import { parseGitHubRepo } from "./reconcile-source.js";

describe("parseGitHubRepo", () => {
  it("parses owner/repo from a github url", () => {
    expect(parseGitHubRepo("https://github.com/acme/cloud")).toEqual({
      owner: "acme",
      repo: "cloud",
    });
  });
  it("strips trailing path and .git", () => {
    expect(parseGitHubRepo("https://github.com/acme/cloud.git/releases")).toEqual({
      owner: "acme",
      repo: "cloud",
    });
  });
  it("accepts the www.github.com host", () => {
    expect(parseGitHubRepo("https://www.github.com/acme/cloud")).toEqual({
      owner: "acme",
      repo: "cloud",
    });
  });
  it("returns null for non-github urls", () => {
    expect(parseGitHubRepo("https://gitlab.com/acme/cloud")).toBeNull();
  });
  it("returns null for owner/repo with unexpected characters", () => {
    expect(parseGitHubRepo("https://github.com/acme/cloud@evil")).toBeNull();
  });
});
