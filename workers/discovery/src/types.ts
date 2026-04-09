import type { Sandbox } from "@cloudflare/sandbox";

export interface OnboardRequest {
  company: string;
  domain?: string;
  githubOrg?: string;
}

export interface OnboardResponse {
  sessionId: string;
  status: "running";
}

export interface StatusResponse {
  status: "running" | "complete" | "error" | "idle";
  progress?: {
    step: string;
    sourcesFound: number;
    sourcesValidated: number;
    currentAction: string;
  };
  result?: object; // DiscoveryState JSON
  error?: string;
}

/** Cloudflare Secrets Store binding — call .get() to retrieve the secret value. */
export type SecretBinding = { get(): Promise<string> };

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  DISCOVERY_SESSION: DurableObjectNamespace;
  MANAGED_AGENTS_SESSION: DurableObjectNamespace;
  DB: D1Database;
  ANTHROPIC_API_KEY: SecretBinding;
  CLOUDFLARE_ACCOUNT_ID: SecretBinding;
  CLOUDFLARE_API_TOKEN: SecretBinding;
  GITHUB_TOKEN?: SecretBinding;
  RELEASED_API_URL: string;
  RELEASED_API_KEY: SecretBinding;
  API_WORKER?: Fetcher;
  /** Discovery engine toggle: "managed-agents" (default) or "sandbox". */
  RELEASED_DISCOVERY_ENGINE?: string;
  /** Pre-created Anthropic Managed Agent ID. */
  ANTHROPIC_AGENT_ID?: string;
  /** Pre-created Anthropic Managed Agent version. */
  ANTHROPIC_AGENT_VERSION?: string;
  /** Pre-created Anthropic Environment ID. */
  ANTHROPIC_ENVIRONMENT_ID?: string;
}
