import type { UserDemographics } from "@buildinternet/releases-api-types";
import { apiBase, errorMessage } from "./user-api";

export async function getDemographics(): Promise<UserDemographics> {
  const res = await fetch(`${apiBase()}/v1/me/demographics`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to load demographics (${res.status})`));
  }
  return (await res.json()) as UserDemographics;
}

export async function updateDemographics(body: UserDemographics): Promise<UserDemographics> {
  const res = await fetch(`${apiBase()}/v1/me/demographics`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to save demographics (${res.status})`));
  }
  return (await res.json()) as UserDemographics;
}
