import { mock } from "bun:test";

// Stub out cloudflare:workers so Bun can import Durable Objects outside a Worker runtime.
mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
