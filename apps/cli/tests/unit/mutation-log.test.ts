import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  shouldRecordMutation,
  buildMutationRecord,
  recordMutation,
} from "../../src/lib/mutation-log.js";

const ENV = "RELEASES_RUN_DIR";

// resolveRunDir falls back to the sticky `.current-run` pointer under
// <dataDir>/work when RELEASES_RUN_DIR is unset (#227). Pin RELEASES_DATA_DIR
// at a fresh temp dir (no pointer) so the "unset" cases stay hermetic and
// independent of the real ~/.releases or test file order.
const dataDir = mkdtempSync(join(tmpdir(), "rel-mut-datadir-"));
let prevDataDir: string | undefined;
beforeAll(() => {
  prevDataDir = process.env.RELEASES_DATA_DIR;
  process.env.RELEASES_DATA_DIR = dataDir;
});
afterAll(() => {
  if (prevDataDir === undefined) delete process.env.RELEASES_DATA_DIR;
  else process.env.RELEASES_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("shouldRecordMutation", () => {
  afterEach(() => {
    delete process.env[ENV];
  });

  it("returns false when RELEASES_RUN_DIR is unset", () => {
    delete process.env[ENV];
    expect(shouldRecordMutation("POST", "/v1/orgs")).toBe(false);
  });

  it("returns false for non-mutating verbs even when the run dir is set", () => {
    process.env[ENV] = "/tmp/x";
    expect(shouldRecordMutation("GET", "/v1/orgs")).toBe(false);
    expect(shouldRecordMutation(undefined, "/v1/orgs")).toBe(false);
  });

  it("returns true for mutating verbs (case-insensitive) when the run dir is set", () => {
    process.env[ENV] = "/tmp/x";
    for (const m of ["POST", "PATCH", "PUT", "DELETE", "patch"]) {
      expect(shouldRecordMutation(m, "/v1/sources/src_1")).toBe(true);
    }
  });

  it("excludes telemetry / read-via-POST plumbing endpoints", () => {
    process.env[ENV] = "/tmp/x";
    expect(shouldRecordMutation("POST", "/v1/status/event")).toBe(false);
    expect(shouldRecordMutation("POST", "/v1/admin/logs/usage")).toBe(false);
    expect(shouldRecordMutation("POST", "/v1/admin/logs/fetch")).toBe(false);
    expect(shouldRecordMutation("POST", "/v1/sources/src_1/content-hash")).toBe(false);
  });
});

describe("buildMutationRecord", () => {
  it("formats a successful mutation (verb upper-cased, target = METHOD path)", () => {
    const rec = buildMutationRecord(
      { method: "patch", path: "/v1/orgs/acme", ok: true, status: 200 },
      "admin org update acme --paused",
      "2026-05-21T00:00:00.000Z",
    );
    expect(rec).toEqual({
      timestamp: "2026-05-21T00:00:00.000Z",
      command: "admin org update acme --paused",
      target: "PATCH /v1/orgs/acme",
      result: "ok 200",
    });
  });

  it("formats a failed mutation with status and error message", () => {
    const rec = buildMutationRecord(
      { method: "DELETE", path: "/v1/sources/src_1", ok: false, status: 404, error: "not found" },
      "admin source delete src_1",
      "2026-05-21T00:00:00.000Z",
    );
    expect(rec.target).toBe("DELETE /v1/sources/src_1");
    expect(rec.result).toBe("error 404: not found");
  });
});

describe("recordMutation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rel-mut-"));
  });
  afterEach(() => {
    delete process.env[ENV];
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends one JSONL line per call to mutations.jsonl", () => {
    process.env[ENV] = dir;
    recordMutation({ method: "POST", path: "/v1/orgs", ok: true, status: 201 });
    recordMutation({ method: "PATCH", path: "/v1/orgs/acme", ok: true, status: 200 });

    const lines = readFileSync(join(dir, "mutations.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(typeof first.timestamp).toBe("string");
    expect(typeof first.command).toBe("string");
    expect(first.target).toBe("POST /v1/orgs");
    expect(first.result).toBe("ok 201");
  });

  it("is a no-op when the run dir is unset", () => {
    delete process.env[ENV];
    recordMutation({ method: "POST", path: "/v1/orgs", ok: true });
    expect(existsSync(join(dir, "mutations.jsonl"))).toBe(false);
  });

  it("creates the run dir if it does not exist yet", () => {
    process.env[ENV] = join(dir, "nested", "run");
    recordMutation({ method: "POST", path: "/v1/orgs", ok: true });
    expect(existsSync(join(dir, "nested", "run", "mutations.jsonl"))).toBe(true);
  });

  it("fails open when the run dir cannot be written", () => {
    // Point the run dir at a regular file so the mkdir/append throws internally.
    const asFile = join(dir, "iam-a-file");
    writeFileSync(asFile, "x");
    process.env[ENV] = asFile;
    expect(() => recordMutation({ method: "POST", path: "/v1/orgs", ok: true })).not.toThrow();
  });
});
