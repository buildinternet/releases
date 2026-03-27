import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import type { Env, StatusResponse } from "./types.js";

type SessionStatus = "idle" | "running" | "complete" | "error";

interface DiscoveryParams {
  company: string;
  domain?: string;
  githubOrg?: string;
  dbSnapshot?: string;
}

const POLL_INTERVAL_MS = 15_000;
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

export class DiscoverySession extends DurableObject<Env> {
  private sandbox?: ReturnType<typeof getSandbox>;

  /** Sandbox container name is capped at 63 chars by Cloudflare. */
  private get sessionId(): string {
    return this.ctx.id.toString().slice(0, 63);
  }

  private async getState<T>(key: string, fallback: T): Promise<T> {
    const val = await this.ctx.storage.get<T>(key);
    return val ?? fallback;
  }

  private getSandboxHandle() {
    if (!this.sandbox) {
      // sleepAfter (vs keepAlive:true) ensures orphaned containers from old deploys
      // clean up instead of lingering indefinitely. Polls every 15s count as activity.
      this.sandbox = getSandbox(this.env.Sandbox, this.sessionId, { sleepAfter: "7m" });
    }
    return this.sandbox;
  }

  private async destroySandbox(): Promise<void> {
    try { await this.getSandboxHandle().destroy(); } catch { /* container already gone */ }
  }

  async startDiscovery(params: DiscoveryParams): Promise<{ sessionId: string }> {
    const currentStatus = await this.getState<SessionStatus>("status", "idle");
    if (currentStatus === "running") {
      throw new Error("Discovery already in progress for this session");
    }

    console.log(`[discovery:${this.sessionId}] startDiscovery company=${params.company}`);

    await this.ctx.storage.put({ params, status: "running", startedAt: Date.now() });
    await this.ctx.storage.delete(["errorMessage", "result", "progress"]);

    await this.ctx.storage.setAlarm(Date.now());

    return { sessionId: this.sessionId };
  }

  async alarm(): Promise<void> {
    const status = await this.getState<SessionStatus>("status", "idle");
    if (status !== "running") return;

    const params = await this.getState<DiscoveryParams | null>("params", null);
    if (params) {
      await this.launchProcess(params);
    } else {
      await this.pollProgress();
    }
  }

  private async launchProcess(params: DiscoveryParams): Promise<void> {
    const sandbox = this.getSandboxHandle();

    try {
      console.log(`[discovery:${this.sessionId}] launchProcess: setting up sandbox`);
      await sandbox.mkdir("/app/data", { recursive: true });
      if (params.dbSnapshot) {
        console.log(`[discovery:${this.sessionId}] writing dbSnapshot (${params.dbSnapshot.length} chars)`);
        await sandbox.writeFile("/app/data/released.db", params.dbSnapshot, { encoding: "base64" });
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
      console.log(`[discovery:${this.sessionId}] startProcess: ${cmd}`);

      await sandbox.startProcess(cmd);
      console.log(`[discovery:${this.sessionId}] process started`);

      await this.ctx.storage.delete("params");
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[discovery:${this.sessionId}] launchProcess failed: ${errMsg}`);
      await this.ctx.storage.put({ status: "error", errorMessage: errMsg });
      await this.destroySandbox();
    }
  }

  private async pollProgress(): Promise<void> {
    const sandbox = this.getSandboxHandle();
    const startedAt = await this.getState<number>("startedAt", Date.now());
    const elapsed = Math.round((Date.now() - startedAt) / 1000);

    console.log(`[discovery:${this.sessionId}] pollProgress (${elapsed}s elapsed)`);

    try {
      const progressFile = await sandbox.readFile("/tmp/discovery-progress.json");
      const progress = JSON.parse(progressFile.content);
      console.log(`[discovery:${this.sessionId}] progress: step=${progress.step} sources=${progress.sourcesFound} validated=${progress.sourcesValidated}`);

      await this.ctx.storage.put("progress", progress);

      if (progress.step === "complete") {
        try {
          const stateFile = await sandbox.readFile("/tmp/discovery-state.json");
          await this.ctx.storage.put("result", JSON.parse(stateFile.content));
          console.log(`[discovery:${this.sessionId}] complete — state file persisted`);
        } catch {
          await this.ctx.storage.put("result", progress);
          console.log(`[discovery:${this.sessionId}] complete — no state file, stored progress`);
        }
        await this.ctx.storage.put("status", "complete");
        await this.destroySandbox();
        return;
      }

      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[discovery:${this.sessionId}] progress file not found: ${msg.slice(0, 200)}`);

      // Check if the agent wrote an error state file before crashing
      try {
        const stateFile = await sandbox.readFile("/tmp/discovery-state.json");
        const state = JSON.parse(stateFile.content);
        if (state.status === "error") {
          console.error(`[discovery:${this.sessionId}] agent error: ${JSON.stringify(state).slice(0, 500)}`);
          await this.ctx.storage.put({ status: "error", errorMessage: state.error || "Discovery agent failed", result: state });
          await this.destroySandbox();
          return;
        }
      } catch {
        // No state file either
      }

      if (msg.includes("not running") || msg.includes("Sandbox error") || msg.includes("proxying request")) {
        console.error(`[discovery:${this.sessionId}] container terminated: ${msg}`);
        await this.ctx.storage.put({ status: "error", errorMessage: `Container terminated: ${msg}` });
        return;
      }

      if (startedAt > 0 && Date.now() - startedAt > SESSION_TIMEOUT_MS) {
        console.error(`[discovery:${this.sessionId}] session timed out`);
        await this.ctx.storage.put({ status: "error", errorMessage: "Session timed out (no progress after 10 minutes)" });
        await this.destroySandbox();
        return;
      }

      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  async getStatus(): Promise<StatusResponse> {
    const status = await this.getState<SessionStatus>("status", "idle");

    if (status === "idle") return { status: "idle" };

    if (status === "error") {
      const errorMessage = await this.getState<string>("errorMessage", "Unknown error");
      return { status: "error", error: errorMessage };
    }

    if (status === "complete") {
      const result = await this.getState<object | null>("result", null);
      return { status: "complete", result: result ?? undefined };
    }

    const progress = await this.getState<StatusResponse["progress"] | null>("progress", null);
    return { status: "running", progress: progress ?? undefined };
  }
}
