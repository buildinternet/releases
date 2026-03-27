import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import type { Env, StatusResponse } from "./types.js";

type SessionStatus = "idle" | "running" | "complete" | "error";

export class DiscoverySession extends DurableObject<Env> {
  private sandbox?: ReturnType<typeof getSandbox>;

  private async getState<T>(key: string, fallback: T): Promise<T> {
    const val = await this.ctx.storage.get<T>(key);
    return val ?? fallback;
  }

  private getSandboxHandle() {
    if (!this.sandbox) {
      this.sandbox = getSandbox(this.env.Sandbox, this.ctx.id.toString().slice(0, 63), {
        keepAlive: true,
      });
    }
    return this.sandbox;
  }

  async startDiscovery(params: {
    company: string;
    domain?: string;
    githubOrg?: string;
    dbSnapshot?: string;
  }): Promise<{ sessionId: string }> {
    const currentStatus = await this.getState<SessionStatus>("status", "idle");
    if (currentStatus === "running") {
      throw new Error("Discovery already in progress for this session");
    }

    const sandbox = this.getSandboxHandle();

    await sandbox.mkdir("/app/data", { recursive: true });
    if (params.dbSnapshot) {
      await sandbox.writeFile("/app/data/released.db", params.dbSnapshot, {
        encoding: "base64",
      });
    }

    // Worker secrets don't propagate into containers — write .env for Bun to auto-load
    const envLines = [
      `ANTHROPIC_API_KEY=${this.env.ANTHROPIC_API_KEY}`,
      `CLOUDFLARE_ACCOUNT_ID=${this.env.CLOUDFLARE_ACCOUNT_ID}`,
      `CLOUDFLARE_API_TOKEN=${this.env.CLOUDFLARE_API_TOKEN}`,
      this.env.GITHUB_TOKEN ? `GITHUB_TOKEN=${this.env.GITHUB_TOKEN}` : "",
    ].filter(Boolean).join("\n");
    await sandbox.writeFile("/app/.env", envLines);

    const args = [JSON.stringify(params.company)];
    if (params.domain) args.push("--domain", params.domain);
    if (params.githubOrg) args.push("--github-org", params.githubOrg);

    const cmd = `bun /app/src/agent/run-discovery.ts ${args.join(" ")}`;

    await this.ctx.storage.put("status", "running" as SessionStatus);
    await this.ctx.storage.put("startedAt", Date.now());
    await this.ctx.storage.delete("errorMessage");

    this.ctx.waitUntil(
      sandbox
        .exec(cmd)
        .then(async (result: { exitCode: number; stderr: string }) => {
          if (result.exitCode !== 0) {
            await this.ctx.storage.put("status", "error" as SessionStatus);
            await this.ctx.storage.put("errorMessage", result.stderr || `Exit code ${result.exitCode}`);
          } else {
            await this.ctx.storage.put("status", "complete" as SessionStatus);
          }
        })
        .catch(async (err: unknown) => {
          await this.ctx.storage.put("status", "error" as SessionStatus);
          await this.ctx.storage.put("errorMessage", err instanceof Error ? err.message : String(err));
        })
        .finally(async () => {
          await sandbox.destroy();
        }),
    );

    return { sessionId: this.ctx.id.toString().slice(0, 63) };
  }

  async getStatus(): Promise<StatusResponse> {
    const status = await this.getState<SessionStatus>("status", "idle");

    if (status === "idle") {
      return { status: "idle" };
    }

    if (status === "error") {
      const errorMessage = await this.getState<string>("errorMessage", "Unknown error");
      return { status: "error", error: errorMessage };
    }

    const sandbox = this.getSandboxHandle();

    if (status === "complete") {
      try {
        const result = await sandbox.readFile("/tmp/discovery-state.json");
        return { status: "complete", result: JSON.parse(result.content) };
      } catch {
        return {
          status: "error",
          error: "State file not found after completion",
        };
      }
    }

    try {
      const result = await sandbox.readFile("/tmp/discovery-progress.json");
      return { status: "running", progress: JSON.parse(result.content) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // If the sandbox is dead (e.g., killed by deploy rollout), surface the error
      if (msg.includes("not running") || msg.includes("Sandbox error") || msg.includes("proxying request")) {
        await this.ctx.storage.put("status", "error" as SessionStatus);
        await this.ctx.storage.put("errorMessage", `Container terminated: ${msg}`);
        return { status: "error", error: `Container terminated: ${msg}` };
      }

      // No progress file — could be early startup or a lost container.
      // If it's been more than 10 minutes, assume the container died silently.
      const startedAt = await this.getState<number>("startedAt", 0);
      if (startedAt > 0 && Date.now() - startedAt > 10 * 60 * 1000) {
        await this.ctx.storage.put("status", "error" as SessionStatus);
        await this.ctx.storage.put("errorMessage", "Session timed out (no progress after 10 minutes)");
        return { status: "error", error: "Session timed out (no progress after 10 minutes)" };
      }

      return { status: "running" };
    }
  }
}
