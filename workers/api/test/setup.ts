import { mock } from "bun:test";

// Stub out cloudflare:workers so Bun can import Durable Objects and
// WorkflowEntrypoints outside a Worker runtime.
mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkflowEntrypoint: class WorkflowEntrypoint {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// Stub cloudflare:workflows. `NonRetryableError` must extend Error and
// carry the right constructor name so the workflow and FakeWorkflowStep
// can detect it via `err.constructor.name`.
mock.module("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {
    constructor(message: string, name?: string) {
      super(message);
      this.name = name ?? "NonRetryableError";
    }
  },
}));
