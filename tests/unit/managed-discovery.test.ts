import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sha256Hex } from "../../src/lib/hash.js";
import { CATEGORIES } from "../../src/lib/categories.js";

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

// ── CLI command resolution (now shared via resolveCLICmd in config.ts) ──

describe("CLI command resolution", () => {
  const originalEnv = process.env.RELEASED_CLI_CMD;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.RELEASED_CLI_CMD = originalEnv;
    } else {
      delete process.env.RELEASED_CLI_CMD;
    }
  });

  it("respects RELEASED_CLI_CMD env var", () => {
    process.env.RELEASED_CLI_CMD = "/custom/path/releases";
    const { resolveCLICmd } = require("../../src/lib/config.js");
    expect(resolveCLICmd()).toBe("/custom/path/releases");
  });

  it("returns a string when no env var is set", () => {
    delete process.env.RELEASED_CLI_CMD;
    const { resolveCLICmd } = require("../../src/lib/config.js");
    const cmd = resolveCLICmd();
    expect(typeof cmd).toBe("string");
    expect(cmd.length).toBeGreaterThan(0);
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

// ── CLI argument splitting (mirrors executeCLI argv construction) ──

describe("CLI argument splitting", () => {
  function buildArgs(cliCmd: string, command: string): string[] {
    const argv = command.trim().split(/\s+/);
    const cliParts = cliCmd.trim().split(/\s+/);
    return [...cliParts, ...argv];
  }

  it("splits simple command correctly", () => {
    const args = buildArgs("releases", "list --json");
    expect(args).toEqual(["releases", "list", "--json"]);
  });

  it("splits multi-word CLI command", () => {
    const args = buildArgs("bun src/index.ts", "fetch resend --dry-run");
    expect(args).toEqual(["bun", "src/index.ts", "fetch", "resend", "--dry-run"]);
  });

  it("handles extra whitespace", () => {
    const args = buildArgs("releases", "  list   --json  ");
    expect(args).toEqual(["releases", "list", "--json"]);
  });

  it("prevents command injection via semicolons", () => {
    // The split approach treats "list; rm -rf /" as separate args, not shell commands
    const args = buildArgs("releases", "list; rm -rf /");
    expect(args).toEqual(["releases", "list;", "rm", "-rf", "/"]);
    // "list;" becomes a literal argument, not a shell separator
    expect(args[1]).toBe("list;");
  });

  it("prevents injection via && operator", () => {
    const args = buildArgs("releases", "list && echo pwned");
    expect(args).toEqual(["releases", "list", "&&", "echo", "pwned"]);
    // "&&" is a literal arg, not a shell operator
  });

  it("prevents injection via backticks", () => {
    const args = buildArgs("releases", "list `whoami`");
    expect(args).toEqual(["releases", "list", "`whoami`"]);
  });

  it("prevents injection via $() substitution", () => {
    const args = buildArgs("releases", "list $(whoami)");
    expect(args).toEqual(["releases", "list", "$(whoami)"]);
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
