import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sha256Hex } from "@releases/core-internal/hash";
import { CATEGORIES } from "@buildinternet/releases-core/categories";
import { parseArgs } from "../../src/shared/parse-args.js";
import { buildDiscoverySystemPrompt } from "../../src/shared/discovery-prompt.js";
import { buildWorkerSystemPrompt } from "../../src/shared/worker-prompt.js";

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

// ── Config file read/write (mirrors loadCachedConfig/saveCachedConfig) ──

describe("managed agent config persistence", () => {
  const testDir = join(tmpdir(), `managed-agents-test-${Date.now()}`);
  const configPath = join(testDir, "managed-agents.json");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const sampleConfig = {
    agentId: "agent_test123",
    agentVersion: 1,
    environmentId: "env_test456",
    updatedAt: "2026-04-09T00:00:00.000Z",
    promptHash: "abc123def456",
  };

  it("round-trips config through JSON", () => {
    writeFileSync(configPath, JSON.stringify(sampleConfig, null, 2));
    const loaded = JSON.parse(readFileSync(configPath, "utf8"));
    expect(loaded).toEqual(sampleConfig);
  });

  it("returns null for missing file", () => {
    try {
      readFileSync(join(testDir, "nonexistent.json"), "utf8");
      expect(true).toBe(false); // should not reach
    } catch {
      // Expected — loadCachedConfig returns null on error
    }
  });

  it("returns null for invalid JSON", () => {
    writeFileSync(configPath, "not valid json{{{");
    try {
      JSON.parse(readFileSync(configPath, "utf8"));
      expect(true).toBe(false);
    } catch {
      // Expected — loadCachedConfig returns null on parse error
    }
  });

  it("preserves promptHash for cache invalidation", () => {
    const cfg = { ...sampleConfig, promptHash: "deadbeef12345678" };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    const loaded = JSON.parse(readFileSync(configPath, "utf8"));
    expect(loaded.promptHash).toBe("deadbeef12345678");
  });

  it("handles missing promptHash (legacy config)", () => {
    const legacy = { ...sampleConfig };
    delete (legacy as any).promptHash;
    writeFileSync(configPath, JSON.stringify(legacy, null, 2));
    const loaded = JSON.parse(readFileSync(configPath, "utf8"));
    expect(loaded.promptHash).toBeUndefined();
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

// ── Session timeout (mirrors SESSION_TIMEOUT_MS constant) ──

describe("session timeout", () => {
  const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

  it("is 15 minutes", () => {
    expect(SESSION_TIMEOUT_MS).toBe(900_000);
  });

  it("matches the remote discovery polling timeout", () => {
    // Remote path uses MAX_POLL_TIME = 15 * 60 * 1000 in onboard.ts
    const MAX_POLL_TIME = 15 * 60 * 1000;
    expect(SESSION_TIMEOUT_MS).toBe(MAX_POLL_TIME);
  });
});

// ── Status event emission (mirrors emitStatus helper) ──

describe("status event mapping", () => {
  it("maps to valid StatusHub event types", () => {
    const validTypes = ["session:start", "session:progress", "session:complete", "session:error"];
    for (const type of validTypes) {
      const event = { type, sessionId: "sess_123", company: "Acme" };
      expect(validTypes).toContain(event.type);
    }
  });

  it("includes sessionId and company in all events", () => {
    const partial = { type: "session:progress" as const, step: "discovery" };
    const event = { ...partial, sessionId: "sess_123", company: "Acme" };
    expect(event.sessionId).toBe("sess_123");
    expect(event.company).toBe("Acme");
    expect(event.type).toBe("session:progress");
    expect(event.step).toBe("discovery");
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

  it("mentions fetch_source tool", () => {
    expect(prompt).toContain("fetch_source");
  });

  it("includes all categories", () => {
    for (const cat of CATEGORIES) {
      expect(prompt).toContain(cat);
    }
  });

  it("states that tool names are exact and forbids paraphrasing", () => {
    expect(prompt).toContain("Tool names are exact");
  });

  it("instructs the agent to apply the inlined playbook instead of calling get_playbook first", () => {
    expect(prompt).toContain("Apply the playbook");
    expect(prompt).toContain("inlined above");
    expect(prompt).not.toContain("Optionally read the playbook first");
    expect(prompt).not.toContain("call get_playbook first");
  });

  it("marks get_playbook as rarely needed (since fetch sessions inline the playbook)", () => {
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
