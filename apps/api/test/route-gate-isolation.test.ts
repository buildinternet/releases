/**
 * Every route module mounts on v1 at "/", so a router's
 * `.use("/prefix/*", gate)` is registered on the shared v1 app and applies to
 * EVERY route under that prefix — including routes another router registers
 * later. #2275 added `workspaceRoutes.use("/integrations/*", …)` and silently
 * put a session gate in front of the Firecrawl and GitHub webhook receivers,
 * which 401'd every delivery until #2428.
 *
 * This test records which router registered each entry in the real v1 route
 * table and fails when one router's middleware covers a route that a
 * different router registered after it. If a cross-router gate is intended,
 * register it in index.ts (or narrow the prefix) instead.
 */
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { mountV1Routes } from "../src/v1-routes.js";

type RouteEntry = { method: string; path: string };
type OwnedEntry = RouteEntry & { owner: number; index: number };

/** Mount routers onto a fresh app, tagging each route-table entry with its router. */
function ownedRouteTable(mount: (v1: Hono) => void): OwnedEntry[] {
  const v1 = new Hono();
  const owners: number[] = [];
  let next = 0;
  const route = v1.route.bind(v1);
  // oxlint-disable-next-line no-explicit-any
  (v1 as any).route = (path: string, sub: Hono) => {
    const start = v1.routes.length;
    const result = route(path, sub);
    const id = ++next;
    for (let i = start; i < v1.routes.length; i++) owners[i] = id;
    return result;
  };
  mount(v1);
  return v1.routes.map((r: RouteEntry, index: number) => ({
    method: r.method,
    path: r.path,
    owner: owners[index] ?? 0, // 0 = registered on v1 directly
    index,
  }));
}

/** Hono path pattern → regex over a sample concrete path. */
function patternRegex(pattern: string): RegExp {
  const body = pattern
    .replace(/:[A-Za-z_]+(\{[^}]*\})?/g, "PARAMSEG")
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\/\*$/, "TAILWILD")
    .replace(/\*/g, ".*")
    .replace(/PARAMSEG/g, "[^/]+")
    .replace(/TAILWILD/g, "(?:/.*)?");
  return new RegExp(`^${body}$`);
}

function samplePath(pattern: string): string {
  return pattern.replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, "x-$1").replace(/\*/g, "x");
}

/** Routes covered by middleware that a different router registered before them. */
function crossRouterGateLeaks(table: OwnedEntry[]): string[] {
  const middleware = table.filter((e) => e.method === "ALL" && e.owner !== 0);
  const leaks = new Set<string>();
  for (const route of table) {
    if (route.method === "ALL") continue;
    const sample = samplePath(route.path);
    for (const mw of middleware) {
      if (mw.index > route.index || mw.owner === route.owner) continue;
      if (patternRegex(mw.path).test(sample)) {
        leaks.add(`${route.method} ${route.path} is gated by another router's use("${mw.path}")`);
      }
    }
  }
  return [...leaks].sort();
}

describe("route gate isolation", () => {
  it("no router's middleware covers another router's routes in the v1 table", () => {
    // oxlint-disable-next-line no-explicit-any
    const table = ownedRouteTable((v1) => mountV1Routes(v1 as any));
    expect(table.some((e) => e.method === "ALL" && e.owner !== 0)).toBe(true);
    expect(crossRouterGateLeaks(table)).toEqual([]);
  });

  it("detects the #2275 shape: a wildcard gate leaking onto a later router", () => {
    const gate: MiddlewareHandler = async (_c, next) => next();
    const workspaces = new Hono();
    workspaces.use("/integrations/*", gate);
    workspaces.post("/integrations/uploads/callback", (c) => c.text("ok"));
    const firecrawl = new Hono();
    firecrawl.post("/integrations/firecrawl/webhook", (c) => c.text("ok"));

    const table = ownedRouteTable((v1) => {
      v1.route("/", workspaces);
      v1.route("/", firecrawl);
    });
    expect(crossRouterGateLeaks(table)).toEqual([
      'POST /integrations/firecrawl/webhook is gated by another router\'s use("/integrations/*")',
    ]);
  });

  it("ignores a gate registered after the other router's route", () => {
    const gate: MiddlewareHandler = async (_c, next) => next();
    const early = new Hono();
    early.get("/me/publish-tokens", (c) => c.text("ok"));
    const late = new Hono();
    late.use("/me/*", gate);
    late.get("/me/follows", (c) => c.text("ok"));

    const table = ownedRouteTable((v1) => {
      v1.route("/", early);
      v1.route("/", late);
    });
    expect(crossRouterGateLeaks(table)).toEqual([]);
  });
});
