import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import {
  resolveToolAlias,
  handleCustomToolUse,
  TOOL_NAME_ALIASES,
  type ToolDispatchContext,
} from "../../src/shared/agent-tools";

/**
 * Regression tests for #555. The Haiku worker agent hallucinates per-action
 * tool names (e.g. `fetch_source`). `resolveToolAlias` rescues these by
 * mapping to the real tool + merging the implied action into input.
 */

describe("resolveToolAlias", () => {
  it("returns null for unknown names", () => {
    expect(resolveToolAlias("completely_made_up", {})).toBeNull();
  });

  it("returns null for real tool names (no aliasing needed)", () => {
    // The real manage_source shouldn't be in the alias map.
    expect(resolveToolAlias("manage_source", { action: "fetch" })).toBeNull();
  });

  it("maps fetch_source → manage_source with action=fetch", () => {
    expect(resolveToolAlias("fetch_source", { identifier: "src_abc" })).toEqual({
      tool: "manage_source",
      input: { identifier: "src_abc", action: "fetch" },
    });
  });

  it("maps edit_source → manage_source with action=edit", () => {
    expect(resolveToolAlias("edit_source", { identifier: "src_abc", url: "https://x" })).toEqual({
      tool: "manage_source",
      input: { identifier: "src_abc", url: "https://x", action: "edit" },
    });
  });

  it("maps delete_source → manage_source with action=remove", () => {
    expect(resolveToolAlias("delete_source", { identifier: "src_abc" })).toEqual({
      tool: "manage_source",
      input: { identifier: "src_abc", action: "remove" },
    });
  });

  it("alias action overrides any conflicting action in input (drift fix wins)", () => {
    expect(resolveToolAlias("fetch_source", { action: "edit", identifier: "src_x" })).toEqual({
      tool: "manage_source",
      input: { action: "fetch", identifier: "src_x" },
    });
  });

  it("covers manage_org aliases", () => {
    expect(resolveToolAlias("edit_org", { identifier: "org_x" })?.tool).toBe("manage_org");
    expect(resolveToolAlias("add_org", { name: "Foo" })?.tool).toBe("manage_org");
  });

  it("covers manage_playbook aliases", () => {
    expect(resolveToolAlias("get_playbook", { organization: "org_x" })).toEqual({
      tool: "manage_playbook",
      input: { organization: "org_x", action: "get" },
    });
    expect(resolveToolAlias("update_playbook", { organization: "org_x", notes: "..." })).toEqual({
      tool: "manage_playbook",
      input: { organization: "org_x", notes: "...", action: "update_notes" },
    });
  });

  it("every alias maps to a known tool prefix", () => {
    const validPrefixes = ["manage_source", "manage_org", "manage_product", "manage_playbook"];
    for (const [alias, target] of Object.entries(TOOL_NAME_ALIASES)) {
      expect(validPrefixes).toContain(target.tool);
      expect(target.mergeInput.action).toBeDefined();
      // Alias name should not collide with any real tool name.
      expect(validPrefixes).not.toContain(alias);
    }
  });
});

describe("handleCustomToolUse alias dispatch", () => {
  let warnSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function makeCtx(): {
    ctx: ToolDispatchContext;
    executorCalls: { tool: string; input: Record<string, unknown> }[];
    sentResults: { id: string; text: string }[];
    onToolCallCalls: { name: string; input: Record<string, unknown> }[];
  } {
    const executorCalls: { tool: string; input: Record<string, unknown> }[] = [];
    const sentResults: { id: string; text: string }[] = [];
    const onToolCallCalls: { name: string; input: Record<string, unknown> }[] = [];
    const ctx: ToolDispatchContext = {
      sendResult: async (id, text) => {
        sentResults.push({ id, text });
      },
      executor: (async (tool: string, input: Record<string, unknown>) => {
        executorCalls.push({ tool, input });
        return `ok: ${tool}`;
      }) as ToolDispatchContext["executor"],
      onToolCall: (name, input) => onToolCallCalls.push({ name, input }),
    };
    return { ctx, executorCalls, sentResults, onToolCallCalls };
  }

  it("dispatches fetch_source to manage_source with action=fetch", async () => {
    const { ctx, executorCalls, sentResults, onToolCallCalls } = makeCtx();

    const isReportState = await handleCustomToolUse(
      { id: "sevt_1", name: "fetch_source", input: { identifier: "src_abc" } },
      ctx,
    );

    expect(isReportState).toBe(false);
    expect(executorCalls).toEqual([
      { tool: "manage_source", input: { identifier: "src_abc", action: "fetch" } },
    ]);
    // onToolCall should see the *resolved* name, so progress tracking reports the real tool.
    expect(onToolCallCalls).toEqual([
      { name: "manage_source", input: { identifier: "src_abc", action: "fetch" } },
    ]);
    expect(sentResults).toEqual([{ id: "sevt_1", text: "ok: manage_source" }]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0] as string).toContain("fetch_source → manage_source");
  });

  it("real tool names pass through unchanged (no warn)", async () => {
    const { ctx, executorCalls, onToolCallCalls } = makeCtx();

    await handleCustomToolUse(
      { id: "sevt_2", name: "manage_source", input: { action: "fetch", identifier: "src_xyz" } },
      ctx,
    );

    expect(executorCalls).toEqual([
      { tool: "manage_source", input: { action: "fetch", identifier: "src_xyz" } },
    ]);
    expect(onToolCallCalls).toEqual([
      { name: "manage_source", input: { action: "fetch", identifier: "src_xyz" } },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("truly unknown tool name errors with guidance for the agent", async () => {
    const { ctx, executorCalls, sentResults } = makeCtx();

    await handleCustomToolUse({ id: "sevt_3", name: "definitely_not_a_tool", input: {} }, ctx);

    expect(executorCalls).toEqual([]);
    expect(sentResults).toHaveLength(1);
    const result = sentResults[0]!;
    expect(result.text).toContain("Unknown tool: definitely_not_a_tool");
    expect(result.text).toContain("manage_source");
    expect(result.text).toContain("action");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
