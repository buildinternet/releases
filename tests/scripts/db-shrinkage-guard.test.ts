import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const guard = join(import.meta.dir, "../../scripts/check-db-shrinkage.sh");
const tempDirs: string[] = [];

async function runGuard(
  rows: Record<string, number>,
  baselines: string[],
  threshold = 10,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const dir = await mkdtemp(join(tmpdir(), "db-shrinkage-guard-"));
  tempDirs.push(dir);
  const dump = join(dir, "dump.sql");
  const statements = Object.entries(rows).flatMap(([table, count]) =>
    Array.from({ length: count }, (_, i) => `INSERT INTO "${table}" VALUES ('${i}');`),
  );
  await writeFile(dump, `${statements.join("\n")}\n`);
  await chmod(guard, 0o755).catch(() => undefined);

  const proc = Bun.spawn([guard, dump, String(threshold), ...baselines], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("database shrinkage guard", () => {
  it("allows a target shrinkage exactly at the threshold", async () => {
    const result = await runGuard({ organizations: 9 }, ["organizations=10"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("organizations: current=10 exported=9 shrinkage=10.00%");
  });

  it("refuses a target shrinkage beyond the threshold", async () => {
    const result = await runGuard({ releases: 8 }, ["releases=10"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("shrinkage guard aborted");
    expect(result.stderr).toContain("releases would shrink from 10 to 8 (20.00%; limit 10%)");
  });

  it("allows an empty baseline because there is nothing to shrink", async () => {
    const result = await runGuard({ sources: 0 }, ["sources=0"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sources: current=0 exported=0 shrinkage=0.00%");
  });

  it("supports a per-job threshold override", async () => {
    const result = await runGuard({ releases: 8 }, ["releases=10"], 20);

    expect(result.exitCode).toBe(0);
  });
});
