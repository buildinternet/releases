import {
  isDeviceAuthPurpose,
  type DeviceAuthPurpose,
} from "@buildinternet/releases-core/api-token";

/**
 * What the approval page says for each device-flow purpose (the `scope` the CLI
 * sends). `login` mints the read-only key; the others are one-shot approvals
 * for a single account command, after which the CLI signs out.
 */
export const DEVICE_PURPOSE_COPY: Record<
  DeviceAuthPurpose,
  { command: string; title: string; permission?: { title: string; desc: string } }
> = {
  login: {
    command: "releases login",
    title: "Approve the Releases CLI on this device",
  },
  keys: {
    command: "releases keys",
    title: "Let the Releases CLI manage your API keys",
    permission: {
      title: "Manage your API keys",
      desc: "List, create, and revoke your personal API keys, for this one command.",
    },
  },
  "publish-tokens": {
    command: "releases publish-token",
    title: "Let the Releases CLI manage publish tokens",
    permission: {
      title: "Manage publish tokens",
      desc: "Create, list, and revoke tokens that publish to sources you've verified, for this one command.",
    },
  },
};

/**
 * The purpose behind a device request, or null for a CLI that predates
 * purposes (it sends no scope, and keeps its session after login).
 */
export function devicePurpose(scope: unknown): DeviceAuthPurpose | null {
  return isDeviceAuthPurpose(scope) ? scope : null;
}
