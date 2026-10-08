/**
 * RFC 8628 device-authorization client for `releases login`, `releases keys`,
 * and `releases publish-token`. Plain `fetch` against the API worker's Better
 * Auth handler — no `better-auth` dependency, so the thin client stays thin.
 *
 * The session token this flow produces is a full-account credential (it can
 * do anything a signed-in browser can), so it is never written to disk. The
 * flow: request a device+user code, have the human approve it in a browser,
 * poll for a session access token, use it for exactly the work at hand, then
 * sign it out. `releases login` additionally exchanges the session for a
 * durable, READ-ONLY `relu_` API key before signing out — the server caps
 * the relu_ lane at read (USER_API_KEY_MAX_SCOPE), so there is no scope
 * choice there.
 */

// Must match DEVICE_AUTH_CLIENT_ID in @buildinternet/releases-core/api-token — the
// worker's validateClient allow-list rejects any other client_id (fail closed).
// Hard-coded until a published core version exposing that constant is adopted; keep
// the literal in lockstep until then.
const CLIENT_ID = "releases-cli";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * What the browser approval is for — sent as `scope` on the device-code
 * request so the web approval page can show a purpose-specific description.
 * The server rejects any other value with a 400 (fail closed).
 */
export type DevicePurpose = "login" | "keys" | "publish-tokens";

const PURPOSE_DESCRIPTIONS: Record<DevicePurpose, string> = {
  login: "Approve in your browser to sign in.",
  keys: "Approve in your browser to manage your API keys.",
  "publish-tokens": "Approve in your browser to manage your publish tokens.",
};

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export async function requestDeviceCode(
  apiUrl: string,
  purpose: DevicePurpose,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCodeResponse> {
  const res = await fetchImpl(`${apiUrl}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": CLIENT_ID },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: purpose }),
  });
  if (!res.ok) {
    throw new Error(`Could not start device login (HTTP ${res.status}).`);
  }
  return (await res.json()) as DeviceCodeResponse;
}

export interface PollOptions {
  intervalSeconds: number;
  expiresInSeconds: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll the token endpoint until approval, denial, or expiry. Returns the access token. */
export async function pollForToken(
  apiUrl: string,
  deviceCode: string,
  opts: PollOptions,
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  let interval = Math.max(0, opts.intervalSeconds);
  const deadline = Date.now() + opts.expiresInSeconds * 1000;

  for (;;) {
    if (Date.now() > deadline) {
      throw new Error("Device code expired before it was approved. Run `releases login` again.");
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential device-flow poll (RFC 8628): wait the server interval before each request
    await sleep(interval * 1000);

    // oxlint-disable-next-line no-await-in-loop -- sequential device-flow poll (RFC 8628): one outstanding poll request at a time
    const res = await fetchImpl(`${apiUrl}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": CLIENT_ID },
      body: JSON.stringify({
        grant_type: GRANT_TYPE,
        device_code: deviceCode,
        client_id: CLIENT_ID,
      }),
    });
    // oxlint-disable-next-line no-await-in-loop -- sequential device-flow poll (RFC 8628): parse this poll's response before the next iteration
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (data.access_token) return data.access_token;

    switch (data.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        continue;
      case "access_denied":
        throw new Error("Authorization was denied in the browser.");
      case "expired_token":
        throw new Error("Device code expired before it was approved. Run `releases login` again.");
      default:
        throw new Error(
          `Device login failed: ${data.error_description ?? data.error ?? "unknown error"}`,
        );
    }
  }
}

export interface SessionUser {
  email: string;
  name?: string;
}

/** Fetch the user behind a device-flow access token (for the "Logged in as" greeting). */
export async function getSessionUser(
  apiUrl: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionUser | null> {
  const res = await fetchImpl(`${apiUrl}/api/auth/get-session`, {
    headers: { authorization: `Bearer ${accessToken}`, "user-agent": CLIENT_ID },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { user?: SessionUser } | null;
  return data?.user ?? null;
}

export interface CreatedKey {
  key: string;
  /** Server-side id of the minted key — absent only if an old server predates it. */
  id?: string;
  name?: string | null;
  /** Ladder label the server granted — "read" for the user lane today. */
  scope?: string;
}

/**
 * Exchange the device-flow session for a durable `relu_` API key. Hits the API
 * worker's own `/v1/api-keys` route — the SAME surface the web panel uses, NOT
 * Better Auth's raw `/api/auth/api-key/create` — so the server injects the owner,
 * caps the scope, and encodes the permission ladder in one place. We request
 * `read` explicitly: user keys are capped read-only server-side, and asking for
 * anything higher is a 400. The device-flow session token rides as a Bearer
 * credential, which the worker's `requireSession` honors via its `bearer()` plugin.
 */
export async function createUserApiKey(
  apiUrl: string,
  accessToken: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedKey> {
  const res = await fetchImpl(`${apiUrl}/v1/api-keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": CLIENT_ID,
    },
    body: JSON.stringify({ name, scope: "read" }),
  });
  if (!res.ok) {
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      // The server's active-key cap. Every mint path surfaces this message,
      // so it carries the way out rather than a bare status code.
      if (body?.error?.code === "api_key_limit") {
        throw new Error(
          `${body.error?.message ?? "API key limit reached."} ` +
            "See your keys with `releases keys list`, revoke unused ones with " +
            "`releases keys revoke <id>`, then sign in again.",
        );
      }
    }
    throw new Error(`Login succeeded but issuing an API key failed (HTTP ${res.status}).`);
  }
  return (await res.json()) as CreatedKey;
}

/**
 * Revoke one API key via the session-gated `DELETE /v1/api-keys/:id` — the
 * same delete `releases keys revoke` uses, called with a session token in hand
 * (mid-login) rather than through a stored-credential lookup.
 */
export async function revokeUserApiKey(
  apiUrl: string,
  sessionToken: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${apiUrl}/v1/api-keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${sessionToken}`, "user-agent": CLIENT_ID },
  });
  if (!res.ok) {
    throw new Error(`Could not revoke API key ${id} (HTTP ${res.status}).`);
  }
}

/**
 * Best-effort revoke of a key the CLI no longer holds (the one a new login
 * replaced). Never throws: returns the failure message, or null on success,
 * for the caller to print however it prints.
 */
export async function revokeKeyQuietly(
  apiUrl: string,
  sessionToken: string,
  id: string,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  try {
    await revokeUserApiKey(apiUrl, sessionToken, id, fetchImpl);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Best-effort sign-out of a device-flow session (`POST /api/auth/sign-out`).
 * Never throws: returns the failure message, or null on success. Called in a
 * `finally` everywhere a session gets established, so a one-shot browser
 * approval never lingers as a live, revocable session after the command that
 * needed it is done.
 */
export async function signOutSession(
  apiUrl: string,
  sessionToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`${apiUrl}/api/auth/sign-out`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json",
        "user-agent": CLIENT_ID,
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) return `Could not sign out (HTTP ${res.status}).`;
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export type RevokePresentedKeyResult =
  | { ok: true; alreadyRevoked: boolean }
  | { ok: false; error: string };

/**
 * Self-revoke the presented `relu_` key via `DELETE /v1/tokens/me` — used by
 * `releases auth logout`, which has the key itself in hand but no session (no
 * browser approval needed to sign yourself out). A 401 means the key is
 * already gone (expired, or revoked elsewhere); the caller treats that as a
 * success-ish outcome, not a failure, and can note it was already revoked.
 */
export async function revokePresentedKey(
  apiUrl: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RevokePresentedKeyResult> {
  try {
    const res = await fetchImpl(`${apiUrl}/v1/tokens/me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}`, "user-agent": CLIENT_ID },
    });
    if (res.status === 401) return { ok: true, alreadyRevoked: true };
    if (!res.ok) return { ok: false, error: `Could not revoke the key (HTTP ${res.status}).` };
    return { ok: true, alreadyRevoked: false };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export interface DeviceLoginDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => boolean;
  print?: (line: string) => void;
}

export interface DeviceAuthArgs {
  apiUrl: string;
  purpose: DevicePurpose;
  openInBrowser: boolean;
  deps?: DeviceLoginDeps;
}

export interface DeviceAuthResult {
  sessionToken: string;
  user: SessionUser | null;
}

/**
 * Run the RFC 8628 device flow and return the session token only — mints NO
 * key. Used by `releases keys`/`releases publish-token` (via `withSession`) to
 * establish a fresh, one-shot session for the management endpoints, and by
 * `releases login` as the first step before minting a key.
 */
export async function runDeviceAuth(args: DeviceAuthArgs): Promise<DeviceAuthResult> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const print = args.deps?.print ?? ((l: string) => console.log(l));

  const code = await requestDeviceCode(args.apiUrl, args.purpose, fetchImpl);

  print(PURPOSE_DESCRIPTIONS[args.purpose]);
  print(`\nTo connect the CLI, visit:\n  ${code.verification_uri}`);
  print(`and enter the code:\n  ${code.user_code}\n`);

  const target = code.verification_uri_complete ?? code.verification_uri;
  if (args.openInBrowser && args.deps?.openBrowser) {
    const ok = args.deps.openBrowser(target);
    print(ok ? "Opening your browser..." : `Open this URL manually:\n  ${target}`);
  } else if (args.openInBrowser) {
    // No injected opener in this context; the command layer wires the real one.
    print(`Open this URL to continue:\n  ${target}`);
  }

  print("Waiting for authorization...");
  const sessionToken = await pollForToken(args.apiUrl, code.device_code, {
    intervalSeconds: code.interval ?? 5,
    expiresInSeconds: code.expires_in,
    fetchImpl,
    sleep: args.deps?.sleep,
  });

  const user = await getSessionUser(args.apiUrl, sessionToken, fetchImpl);
  if (user) print(`Authorized as ${user.name ?? user.email}.`);

  return { sessionToken, user };
}
