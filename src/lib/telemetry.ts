import { readFileSync, writeFileSync, existsSync, chmodSync, unlinkSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getDataDir } from "./config.js";
import { VERSION } from "../cli/version.js";
import type { TelemetryClientKind, TelemetrySurface } from "@releases/core/schema";

const ANON_ID_FILE = "telemetry-id";
const DISABLE_FILE = "telemetry-disabled";
const NOTICE_FILE = "telemetry-notice-shown";
const DEFAULT_ENDPOINT = "https://api.releases.sh";
const POST_TIMEOUT_MS = 1500;

function filePath(name: string): string {
  return join(getDataDir(), name);
}

function safeRead(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
  } catch {
    return null;
  }
}

function safeWrite(path: string, content: string, mode?: number): void {
  try {
    writeFileSync(path, content, "utf8");
    if (mode !== undefined) chmodSync(path, mode);
  } catch {
    // ignore — telemetry must never throw
  }
}

export function getOrCreateAnonId(): string {
  const path = filePath(ANON_ID_FILE);
  const existing = safeRead(path);
  if (existing && existing.length > 0) return existing;
  const id = randomUUID();
  safeWrite(path, id, 0o600);
  return id;
}

export function isTelemetryEnabled(): boolean {
  if (process.env.RELEASED_TELEMETRY_DISABLED === "1") return false;
  if (process.env.DO_NOT_TRACK === "1") return false;
  if (existsSync(filePath(DISABLE_FILE))) return false;
  return true;
}

export function setTelemetryEnabled(enabled: boolean): void {
  const path = filePath(DISABLE_FILE);
  if (enabled) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // ignore
    }
  } else {
    safeWrite(path, "disabled\n");
  }
}

function detectClientKind(): { kind: TelemetryClientKind; sessionId?: string; agentName?: string; model?: string } {
  const envKind = process.env.RELEASED_CLIENT_KIND as TelemetryClientKind | undefined;
  if (envKind) {
    return {
      kind: envKind,
      sessionId: process.env.RELEASED_CLIENT_SESSION_ID,
      agentName: process.env.RELEASED_CLIENT_AGENT,
      model: process.env.RELEASED_CLIENT_MODEL,
    };
  }
  if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
    return { kind: "internal-ci" };
  }
  return { kind: "external" };
}

function detectRuntime(): string {
  const bun = (globalThis as { Bun?: { version?: string } }).Bun;
  if (bun?.version) return `bun-${bun.version}`;
  if (typeof process !== "undefined" && process.versions?.node) {
    return `node-${process.versions.node}`;
  }
  return "unknown";
}

export function maybeShowFirstRunNotice(): void {
  if (!isTelemetryEnabled()) return;
  const kind = detectClientKind().kind;
  if (kind !== "external") return;
  const marker = filePath(NOTICE_FILE);
  if (existsSync(marker)) return;
  process.stderr.write(
    [
      "",
      "\x1b[2mreleases collects anonymous usage data (command name, CLI version, OS).\x1b[0m",
      "\x1b[2mNo arguments, paths, slugs, or content are sent. Opt out with:\x1b[0m",
      "\x1b[2m  releases telemetry disable   # or set RELEASED_TELEMETRY_DISABLED=1\x1b[0m",
      "",
    ].join("\n"),
  );
  safeWrite(marker, new Date().toISOString());
}

export interface TelemetryEventInput {
  surface: TelemetrySurface;
  command: string;
  exitCode?: number;
  durationMs?: number;
}

function endpoint(): string {
  return (process.env.RELEASED_API_URL || DEFAULT_ENDPOINT).replace(/\/$/, "");
}

export async function recordEvent(input: TelemetryEventInput): Promise<void> {
  if (!isTelemetryEnabled()) return;
  try {
    const ctx = detectClientKind();
    const body = {
      anonId: getOrCreateAnonId(),
      timestamp: Date.now(),
      surface: input.surface,
      clientKind: ctx.kind,
      sessionId: ctx.sessionId ?? null,
      agentName: ctx.agentName ?? null,
      model: ctx.model ?? null,
      command: input.command,
      exitCode: input.exitCode ?? null,
      durationMs: input.durationMs ?? null,
      cliVersion: VERSION,
      os: process.platform,
      arch: process.arch,
      runtime: detectRuntime(),
    };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      await fetch(`${endpoint()}/v1/telemetry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
  } catch {
    // fire-and-forget
  }
}

export function telemetryStatus(): {
  enabled: boolean;
  anonId: string;
  clientKind: TelemetryClientKind;
  endpoint: string;
  reason?: string;
} {
  const enabled = isTelemetryEnabled();
  let reason: string | undefined;
  if (process.env.RELEASED_TELEMETRY_DISABLED === "1") reason = "RELEASED_TELEMETRY_DISABLED=1";
  else if (process.env.DO_NOT_TRACK === "1") reason = "DO_NOT_TRACK=1";
  else if (existsSync(filePath(DISABLE_FILE))) reason = `${filePath(DISABLE_FILE)} present`;
  return {
    enabled,
    anonId: getOrCreateAnonId(),
    clientKind: detectClientKind().kind,
    endpoint: endpoint(),
    reason,
  };
}
