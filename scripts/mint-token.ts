#!/usr/bin/env bun
/**
 * Mint a scoped API token via POST /v1/tokens using the static root key.
 * Requires RELEASED_API_URL and RELEASED_API_KEY in the environment (.env auto-loads).
 *
 * Usage:
 *   bun scripts/mint-token.ts --name "CI deploy" --scopes write
 *   bun scripts/mint-token.ts --name "reader" --scopes read --principal-type agent
 */
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apiUrl = process.env.RELEASED_API_URL?.replace(/\/+$/, "");
  const apiKey = process.env.RELEASED_API_KEY;
  if (!apiUrl || !apiKey) {
    console.error("Set RELEASED_API_URL and RELEASED_API_KEY (the static root key) first.");
    process.exit(1);
  }

  const name = arg("--name");
  const scopes = (arg("--scopes") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const principalType = arg("--principal-type") ?? "internal";
  if (!name || scopes.length === 0) {
    console.error('Required: --name "<label>" --scopes <read|write|admin[,...]>');
    process.exit(1);
  }

  const res = await fetch(`${apiUrl}/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ name, scopes, principalType }),
  });

  if (!res.ok) {
    console.error(`Mint failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const body = (await res.json()) as { token: string; id: string; scopes: string[] };
  console.log("Token minted. This is the ONLY time the full token is shown:\n");
  console.log(`  ${body.token}\n`);
  console.log(`id: ${body.id}  scopes: ${body.scopes.join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
