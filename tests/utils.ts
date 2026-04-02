import { execSync } from "child_process";
import { join } from "path";
import { stripAnsi } from "../src/lib/sanitize.js";

const CLI_PATH = join(import.meta.dirname, "..", "src", "index.ts");

export function runCli(
  args: string[],
  options?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const result = execSync(`bun ${CLI_PATH} ${args.join(" ")}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: options?.env ? { ...process.env, ...options.env } : undefined,
      timeout: options?.timeout ?? 30_000,
    });
    return { stdout: stripAnsi(result), stderr: "", exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: stripAnsi(error.stdout ?? ""),
      stderr: stripAnsi(error.stderr ?? ""),
      exitCode: error.status ?? 1,
    };
  }
}
