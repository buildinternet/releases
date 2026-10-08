import { describe, it, expect } from "bun:test";
import {
  shouldShowCompletionHint,
  shouldShowCompletionNotice,
  completionNoticeLine,
} from "../../src/cli/completion/hint.js";

const TTY: Parameters<typeof shouldShowCompletionHint>[0] = {
  isInteractive: true,
  hintAlreadyShown: false,
  completionFileExists: false,
  env: { SHELL: "/bin/zsh" },
};

describe("shouldShowCompletionHint", () => {
  it("shows when interactive + first run + no completion file", () => {
    expect(shouldShowCompletionHint(TTY)).toBe(true);
  });

  it("suppresses if hint marker exists", () => {
    expect(shouldShowCompletionHint({ ...TTY, hintAlreadyShown: true })).toBe(false);
  });

  it("suppresses if completion file already on disk", () => {
    expect(shouldShowCompletionHint({ ...TTY, completionFileExists: true })).toBe(false);
  });

  it("suppresses in non-interactive context (pipe, CI)", () => {
    expect(shouldShowCompletionHint({ ...TTY, isInteractive: false })).toBe(false);
  });

  it("suppresses on unsupported shells", () => {
    expect(shouldShowCompletionHint({ ...TTY, env: { SHELL: "/bin/csh" } })).toBe(false);
    expect(shouldShowCompletionHint({ ...TTY, env: {} })).toBe(false);
  });

  it("suppresses when RELEASES_NO_COMPLETION_HINT=1", () => {
    expect(
      shouldShowCompletionHint({
        ...TTY,
        env: { SHELL: "/bin/zsh", RELEASES_NO_COMPLETION_HINT: "1" },
      }),
    ).toBe(false);
  });

  it("suppresses for CI / agent clients", () => {
    expect(
      shouldShowCompletionHint({
        ...TTY,
        env: { SHELL: "/bin/zsh", CI: "true" },
      }),
    ).toBe(false);
    expect(
      shouldShowCompletionHint({
        ...TTY,
        env: { SHELL: "/bin/zsh", RELEASED_CLIENT_KIND: "managed-agent" },
      }),
    ).toBe(false);
  });

  it("treats common truthy CI flag values case-insensitively", () => {
    for (const value of ["true", "TRUE", "1", "yes", "YES"]) {
      expect(
        shouldShowCompletionHint({
          ...TTY,
          env: { SHELL: "/bin/zsh", CI: value },
        }),
      ).toBe(false);
      expect(
        shouldShowCompletionHint({
          ...TTY,
          env: { SHELL: "/bin/zsh", GITHUB_ACTIONS: value },
        }),
      ).toBe(false);
    }
  });
});

describe("shouldShowCompletionNotice", () => {
  const BASE: Parameters<typeof shouldShowCompletionNotice>[0] = {
    shell: "zsh",
    userCompletionExists: false,
    systemCompletionExists: false,
    env: {},
  };

  it("shows when a shell is known and no completions are installed anywhere", () => {
    expect(shouldShowCompletionNotice(BASE)).toBe(true);
  });

  it("self-resolves once the user-level completion file exists", () => {
    expect(shouldShowCompletionNotice({ ...BASE, userCompletionExists: true })).toBe(false);
  });

  it("self-resolves once a package manager (e.g. Homebrew) installed completions", () => {
    expect(shouldShowCompletionNotice({ ...BASE, systemCompletionExists: true })).toBe(false);
  });

  it("suppresses when the shell can't be detected", () => {
    expect(shouldShowCompletionNotice({ ...BASE, shell: null })).toBe(false);
  });

  it("suppresses when RELEASES_NO_COMPLETION_HINT is set", () => {
    expect(shouldShowCompletionNotice({ ...BASE, env: { RELEASES_NO_COMPLETION_HINT: "1" } })).toBe(
      false,
    );
  });

  it("suppresses for non-external client kinds (managed agents)", () => {
    expect(
      shouldShowCompletionNotice({ ...BASE, env: { RELEASED_CLIENT_KIND: "managed-agent" } }),
    ).toBe(false);
  });

  it("unlike the one-time hint, has no marker/interactive gate — it persists", () => {
    // Same inputs twice always returns true until completions are detected.
    expect(shouldShowCompletionNotice(BASE)).toBe(true);
    expect(shouldShowCompletionNotice(BASE)).toBe(true);
  });

  it("notice text names the detected shell and the install command", () => {
    expect(completionNoticeLine("zsh")).toContain("releases completion install zsh");
    expect(completionNoticeLine("fish")).toContain("releases completion install fish");
  });
});
