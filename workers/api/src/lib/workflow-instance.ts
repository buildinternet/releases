/** Cloudflare Workflows throws a generic Error when `binding.get()` misses. */
export const WORKFLOW_NOT_FOUND_RE = /not\s*found|does\s+not\s+exist/i;

type WorkflowBinding = {
  get(id: string): Promise<{
    status(): Promise<Record<string, unknown>>;
    terminate(): Promise<void>;
  }>;
};

export async function workflowInstanceStatus(
  binding: WorkflowBinding | undefined,
  instanceId: string,
): Promise<
  | { ok: true; status: Record<string, unknown> }
  | { ok: false; code: "unavailable" | "not_found" | "error"; message: string }
> {
  if (!binding) {
    return { ok: false, code: "unavailable", message: "workflow binding not configured" };
  }
  try {
    const instance = await binding.get(instanceId);
    const status = await instance.status();
    return { ok: true, status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (WORKFLOW_NOT_FOUND_RE.test(message)) {
      return { ok: false, code: "not_found", message };
    }
    return { ok: false, code: "error", message };
  }
}

export async function workflowInstanceTerminate(
  binding: WorkflowBinding | undefined,
  instanceId: string,
): Promise<
  { ok: true } | { ok: false; code: "unavailable" | "not_found" | "error"; message: string }
> {
  if (!binding) {
    return { ok: false, code: "unavailable", message: "workflow binding not configured" };
  }
  try {
    const instance = await binding.get(instanceId);
    await instance.terminate();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (WORKFLOW_NOT_FOUND_RE.test(message)) {
      return { ok: false, code: "not_found", message };
    }
    return { ok: false, code: "error", message };
  }
}
