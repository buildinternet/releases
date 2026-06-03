/**
 * Shape guard for the hand-authored managed-agent environment mirrors. These
 * files are the source of truth (the env config is static, not generated), so
 * this is the CI net against a malformed hand-edit — there is no render --check
 * for environments.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";

const ENVS = ["production", "staging"] as const;

describe("managed-agent environment YAML", () => {
  for (const env of ENVS) {
    it(`${env} mirror is well-formed`, () => {
      const path = resolve(import.meta.dir, "../../managed-agents", `${env}.environment.yaml`);
      const def = parse(readFileSync(path, "utf8")) as Record<string, any>;
      expect(typeof def.name).toBe("string");
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.config?.type).toBe("cloud");
      expect(typeof def.config?.networking?.type).toBe("string");
    });
  }
});
