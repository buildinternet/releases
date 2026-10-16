import { Hono } from "hono";
import type { AdminDatasetsResponse } from "@buildinternet/releases-api-types";
import {
  DATASET_ORG_INDEX_MIN_RELEASES,
  getDefaultSourceDataset,
  readSourceDatasetSettings,
  resolveSourceDataset,
} from "@releases/core-internal/source-dataset";
import { ForbiddenError } from "@releases/lib/releases-error";
import { createDb } from "../db.js";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { parseListPagination } from "../lib/pagination.js";
import { isValidBearerAuth } from "../middleware/auth.js";
import { listDatasetSources } from "../queries/admin-datasets.js";

export const adminDatasetsRoutes = new Hono<Env>();
adminDatasetsRoutes.get("/admin/datasets", async (c) => {
  if (!(await isValidBearerAuth(c)))
    return respondError(c, new ForbiddenError("Admin scope required."));
  const query = (c.req.query("q") ?? "").trim().slice(0, 200);
  const { page, pageSize, offset } = parseListPagination(new URL(c.req.url).searchParams, {
    defaultPageSize: 25,
    maxPageSize: 100,
  });
  const rows = await listDatasetSources(createDb(c.env.DB), query, pageSize + 1, offset);
  const response: AdminDatasetsResponse = {
    query,
    pagination: { page, limit: pageSize, hasMore: rows.length > pageSize },
    sources: rows.slice(0, pageSize).map((row) => {
      const ref = { ...row, isHidden: !!row.isHidden };
      const stored = readSourceDatasetSettings(row.metadata);
      const blockedReasons: string[] = [];
      if (row.isHidden) blockedReasons.push("Source is hidden");
      if (row.discovery === "on_demand") blockedReasons.push("Source is on-demand");
      if (!row.orgSlug) blockedReasons.push("Source has no organization");
      else {
        if (row.orgHidden || row.orgDeleted)
          blockedReasons.push("Organization is hidden or deleted");
        if (row.orgDiscovery === "on_demand") blockedReasons.push("Organization is on-demand");
        if (row.orgTier !== "tracked") blockedReasons.push("Organization is not tracked");
        if (!row.hasOverview || row.releaseCount < DATASET_ORG_INDEX_MIN_RELEASES)
          blockedReasons.push(
            `Organization needs an overview and at least ${DATASET_ORG_INDEX_MIN_RELEASES} releases`,
          );
      }
      if (!stored.valid) blockedReasons.push("Stored dataset settings are invalid");
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        orgSlug: row.orgSlug,
        orgName: row.orgName,
        defaultEnabled: !!getDefaultSourceDataset(ref),
        settings: stored.value,
        effective: resolveSourceDataset(ref) ?? null,
        blockedReasons,
      };
    }),
  };
  c.header("Cache-Control", "private, no-store");
  return c.json(response);
});
