import "server-only";

import { cookies } from "next/headers";
import type {
  DeveloperSettingsResponse,
  NotificationSettingsResponse,
} from "@buildinternet/releases-api-types";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl } from "@/lib/env";

async function fetchMeSettingsPath<T>(path: string): Promise<T | null> {
  const base = apiBaseUrl();
  if (!base) return null;
  const cookie = (await cookies()).toString();
  if (!cookie) return null;
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
      headers: webApiHeaders({ Cookie: cookie }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** RSC bootstrap for `/account/notifications`. Null when anonymous / API down. */
export function fetchNotificationSettingsServer(): Promise<NotificationSettingsResponse | null> {
  return fetchMeSettingsPath("/v1/me/settings/notifications");
}

/** RSC bootstrap for `/account/webhooks`. Null when anonymous / API down. */
export function fetchDeveloperSettingsServer(): Promise<DeveloperSettingsResponse | null> {
  return fetchMeSettingsPath("/v1/me/settings/developer");
}
