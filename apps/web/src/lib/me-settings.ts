/**
 * Browser client for account settings bootstraps (`/v1/me/settings/*`).
 * Sibling of the RSC cookie-forward helpers in `me-settings-server.ts`.
 */

import type {
  DeveloperSettingsResponse,
  NotificationSettingsResponse,
} from "@buildinternet/releases-api-types";
import { meGet } from "./user-api";

export type { NotificationSettingsResponse, DeveloperSettingsResponse };

/** One-shot load for `/account/notifications`. */
export function getNotificationSettings(): Promise<NotificationSettingsResponse> {
  return meGet("/v1/me/settings/notifications", "Failed to load notification settings");
}

/** One-shot load for `/account/webhooks` (Webhooks & API). */
export function getDeveloperSettings(): Promise<DeveloperSettingsResponse> {
  return meGet("/v1/me/settings/developer", "Failed to load developer settings");
}
