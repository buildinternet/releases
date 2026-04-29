import { describe, it, expect } from "bun:test";
import { sha256Hex } from "@releases/core-internal/hash";
import { CATEGORIES } from "@buildinternet/releases-core/categories";
import { parseArgs } from "../../src/shared/parse-args.js";
import { buildDiscoverySystemPrompt } from "../../src/shared/discovery-prompt.js";
import { buildWorkerSystemPrompt } from "../../src/shared/worker-prompt.js";
import {
  classifyProviderSessionError,
  isRetriesExhaustedIdle,
} from "../../workers/discovery/src/session-error-classify.js";

/**
 * Unit tests for managed-discovery module internals.
 *
 * These test the pure/deterministic helpers without hitting the Anthropic API.
 * The module's functions are not individually exported, so we test the behaviors
 * through their observable effects (config files, prompt content) and by
 * re-implementing the same logic to verify correctness.
 */

// ── Prompt hash logic (mirrors hashPrompt in managed-discovery.ts) ──

describe("prompt hashing", () => {
  function hashPrompt(prompt: string): string {
    return sha256Hex(prompt).slice(0, 16);
  }

  it("returns a 16-char hex string", () => {
    expect(hashPrompt("test")).toMatch(/^[a-f0-9]{16}$/);
  });

  it("is deterministic", () => {
    const prompt = "You manage changelog sources";
    expect(hashPrompt(prompt)).toBe(hashPrompt(prompt));
  });

  it("changes when prompt content changes", () => {
    const a = hashPrompt("prompt version 1");
    const b = hashPrompt("prompt version 2");
    expect(a).not.toBe(b);
  });

  it("detects category list changes", () => {
    const base = `categories: ${CATEGORIES.join(", ")}`;
    const modified = `categories: ${[...CATEGORIES, "new-category"].join(", ")}`;
    expect(hashPrompt(base)).not.toBe(hashPrompt(modified));
  });
});

// ── System prompt content ──

describe("system prompt content", () => {
  // We can't call buildSystemPrompt() directly since it's not exported,
  // but we can verify the expected content structure.

  it("CATEGORIES array is non-empty", () => {
    expect(CATEGORIES.length).toBeGreaterThanOrEqual(10);
  });

  it("CATEGORIES contains expected entries", () => {
    expect(CATEGORIES).toContain("ai");
    expect(CATEGORIES).toContain("developer-tools");
    expect(CATEGORIES).toContain("cloud");
  });

  it("CATEGORIES entries are lowercase kebab-case", () => {
    for (const cat of CATEGORIES) {
      expect(cat).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});

// ── parseArgs (shell-style tokenizer) ──

describe("parseArgs", () => {
  it("splits simple command correctly", () => {
    expect(parseArgs("list --json")).toEqual(["list", "--json"]);
  });

  it("handles extra whitespace", () => {
    expect(parseArgs("  list   --json  ")).toEqual(["list", "--json"]);
  });

  it("preserves double-quoted strings", () => {
    expect(parseArgs('org add "Val Town" --category ai')).toEqual([
      "org",
      "add",
      "Val Town",
      "--category",
      "ai",
    ]);
  });

  it("preserves single-quoted strings", () => {
    expect(parseArgs("org add 'Val Town' --category ai")).toEqual([
      "org",
      "add",
      "Val Town",
      "--category",
      "ai",
    ]);
  });

  it("handles --description with quoted multi-word value", () => {
    expect(
      parseArgs('org add "Val Town" --description "A platform for writing and deploying code"'),
    ).toEqual([
      "org",
      "add",
      "Val Town",
      "--description",
      "A platform for writing and deploying code",
    ]);
  });

  it("handles backslash escapes", () => {
    expect(parseArgs("org add Val\\ Town")).toEqual(["org", "add", "Val Town"]);
  });

  it("handles empty quoted string", () => {
    expect(parseArgs('add "" --url http://example.com')).toEqual([
      "add",
      "",
      "--url",
      "http://example.com",
    ]);
  });

  it("handles mixed quotes", () => {
    expect(parseArgs(`org add "Val Town" --tags 'a,b,c'`)).toEqual([
      "org",
      "add",
      "Val Town",
      "--tags",
      "a,b,c",
    ]);
  });

  it("prevents command injection via semicolons", () => {
    const args = parseArgs("list; rm -rf /");
    expect(args).toEqual(["list;", "rm", "-rf", "/"]);
  });

  it("prevents injection via && operator", () => {
    expect(parseArgs("list && echo pwned")).toEqual(["list", "&&", "echo", "pwned"]);
  });

  it("prevents injection via backticks", () => {
    expect(parseArgs("list `whoami`")).toEqual(["list", "`whoami`"]);
  });

  it("prevents injection via $() substitution", () => {
    expect(parseArgs("list $(whoami)")).toEqual(["list", "$(whoami)"]);
  });

  it("returns empty array for empty input", () => {
    expect(parseArgs("")).toEqual([]);
    expect(parseArgs("   ")).toEqual([]);
  });
});

// ── Shared discovery prompt ──

describe("buildDiscoverySystemPrompt", () => {
  it("includes evaluate_url tool when evaluateAvailable is true", () => {
    const prompt = buildDiscoverySystemPrompt({
      evaluateAvailable: true,
      categories: [...CATEGORIES],
    });
    expect(prompt).toContain("evaluate_url");
  });

  it("excludes evaluate_url tool when evaluateAvailable is false", () => {
    const prompt = buildDiscoverySystemPrompt({
      evaluateAvailable: false,
      categories: [...CATEGORIES],
    });
    expect(prompt).not.toContain("**evaluate_url**");
    expect(prompt).toContain("not available in this mode");
  });

  it("includes all categories", () => {
    const prompt = buildDiscoverySystemPrompt({
      evaluateAvailable: true,
      categories: [...CATEGORIES],
    });
    for (const cat of CATEGORIES) {
      expect(prompt).toContain(cat);
    }
  });

  it("accepts readonly categories array", () => {
    // Verifies the parameter type accepts CATEGORIES (readonly) without spreading
    const prompt = buildDiscoverySystemPrompt({
      evaluateAvailable: true,
      categories: CATEGORIES,
    });
    expect(prompt).toContain(CATEGORIES[0]);
  });
});

// ── Worker prompt content ──

describe("buildWorkerSystemPrompt", () => {
  const prompt = buildWorkerSystemPrompt({ categories: CATEGORIES });

  it("instructs agent to use identifier parameter", () => {
    expect(prompt).toContain("`identifier`");
  });

  it("shows source ID example format", () => {
    expect(prompt).toContain("src_");
  });

  it("mentions the manage_source tool for fetch operations", () => {
    expect(prompt).toContain("manage_source");
    expect(prompt).toContain("action=fetch");
  });

  it("includes all categories", () => {
    for (const cat of CATEGORIES) {
      expect(prompt).toContain(cat);
    }
  });

  it("states that tool names are exact and forbids paraphrasing", () => {
    expect(prompt).toContain("Tool names are exact");
  });

  it("instructs the agent to apply the inlined playbook instead of re-reading it first", () => {
    expect(prompt).toContain("Apply the playbook");
    expect(prompt).toContain("inlined above");
    expect(prompt).not.toContain("Optionally read the playbook first");
    expect(prompt).not.toContain("call manage_playbook(get) first");
  });

  it("marks playbook reads as rarely needed (since fetch sessions inline the playbook)", () => {
    expect(prompt).toContain("rarely needed");
  });
});

// ── Update session error detection (mirrors logic in managed-agents-session.ts) ──

/**
 * Mirrors the decision logic at the end of runSession() for update mode.
 * Given tool call counts, determines whether the session should fail or complete.
 */
function shouldFail(toolCallCount: number, toolErrors: number): boolean {
  return toolCallCount === 0 || (toolErrors > 0 && toolErrors >= toolCallCount);
}

describe("update session error detection", () => {
  it("fails when no tool calls were made", () => {
    expect(shouldFail(0, 0)).toBe(true);
  });

  it("fails when all tool calls errored", () => {
    expect(shouldFail(1, 1)).toBe(true);
    expect(shouldFail(3, 3)).toBe(true);
  });

  it("succeeds when some tool calls succeeded", () => {
    expect(shouldFail(3, 1)).toBe(false);
    expect(shouldFail(5, 2)).toBe(false);
  });

  it("succeeds when no errors occurred", () => {
    expect(shouldFail(1, 0)).toBe(false);
    expect(shouldFail(5, 0)).toBe(false);
  });

  it("fails when more errors than calls (edge case)", () => {
    // Shouldn't happen in practice, but should still fail
    expect(shouldFail(1, 2)).toBe(true);
  });
});

// ── Error string detection (mirrors sendResult check in managed-agents-session.ts) ──

function isError(result: string): boolean {
  return result.startsWith("Error");
}

describe("tool error detection via result prefix", () => {
  it("detects standard error responses", () => {
    expect(isError("Error: identifier is required")).toBe(true);
    expect(isError("Error (HTTP 404): not found")).toBe(true);
  });

  it("does not flag success responses", () => {
    expect(isError("Fetched 5 releases")).toBe(false);
    expect(isError("State captured successfully.")).toBe(false);
    expect(isError("Source removed")).toBe(false);
  });

  it("does not flag unknown tool responses", () => {
    expect(isError("Unknown tool: bad_tool")).toBe(false);
  });
});

// ── Provider session error classification ──

describe("classifyProviderSessionError", () => {
  it("classifies an unknown_error session.error event", () => {
    const event = {
      type: "session.error",
      error: {
        type: "unknown_error",
        message: "An internal service error occurred.",
        retry_status: { type: "retrying" },
      },
    };
    expect(classifyProviderSessionError(event)).toEqual({
      errorSource: "provider",
      errorType: "unknown_error",
      message: "An internal service error occurred.",
    });
  });

  it("classifies a model_overloaded_error session.error event", () => {
    const event = {
      type: "session.error",
      error: { type: "model_overloaded_error", message: "Model overloaded." },
    };
    expect(classifyProviderSessionError(event)).toEqual({
      errorSource: "provider",
      errorType: "model_overloaded_error",
      message: "Model overloaded.",
    });
  });

  it("falls back to a generic message when error.message is missing", () => {
    const event = { type: "session.error", error: { type: "unknown_error" } };
    expect(classifyProviderSessionError(event)?.message).toBe("Unknown managed-agents error");
  });

  it("returns null for non-session.error events", () => {
    expect(classifyProviderSessionError({ type: "agent.message" })).toBeNull();
    expect(classifyProviderSessionError({ type: "session.status_idle" })).toBeNull();
    expect(classifyProviderSessionError(null)).toBeNull();
    expect(classifyProviderSessionError(undefined)).toBeNull();
  });
});

describe("isRetriesExhaustedIdle", () => {
  it("matches status_idle with retries_exhausted stop_reason", () => {
    expect(
      isRetriesExhaustedIdle({
        type: "session.status_idle",
        stop_reason: { type: "retries_exhausted" },
      }),
    ).toBe(true);
  });

  it("does not match status_idle with end_turn or requires_action", () => {
    expect(
      isRetriesExhaustedIdle({
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      }),
    ).toBe(false);
    expect(
      isRetriesExhaustedIdle({
        type: "session.status_idle",
        stop_reason: { type: "requires_action", event_ids: [] },
      }),
    ).toBe(false);
  });

  it("does not match other event types", () => {
    expect(isRetriesExhaustedIdle({ type: "session.error" })).toBe(false);
    expect(isRetriesExhaustedIdle({ type: "session.status_terminated" })).toBe(false);
    expect(isRetriesExhaustedIdle(null)).toBe(false);
  });
});

// ── Output truncation (mirrors the truncation logic in event handler) ──

describe("output truncation", () => {
  const MAX_LEN = 50_000;

  function truncate(result: string): string {
    if (result.length > MAX_LEN) {
      return result.slice(0, MAX_LEN) + `\n\n[output truncated — ${result.length} total chars]`;
    }
    return result;
  }

  it("passes through short output unchanged", () => {
    const short = "hello world";
    expect(truncate(short)).toBe(short);
  });

  it("passes through exactly-at-limit output unchanged", () => {
    const exact = "x".repeat(MAX_LEN);
    expect(truncate(exact)).toBe(exact);
  });

  it("truncates output exceeding limit", () => {
    const long = "x".repeat(MAX_LEN + 100);
    const result = truncate(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain("[output truncated");
    expect(result).toContain(`${long.length} total chars`);
  });

  it("preserves the first MAX_LEN chars", () => {
    const prefix = "MARKER_START_";
    const long = prefix + "x".repeat(MAX_LEN + 100);
    const result = truncate(long);
    expect(result.startsWith(prefix)).toBe(true);
  });
});
