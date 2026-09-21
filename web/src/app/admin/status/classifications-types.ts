/**
 * Wire shapes for `GET /v1/admin/classifications/summary` and `/recent`.
 * The published contract is `@buildinternet/releases-api-types`.
 */
import type {
  ClassificationRecentItem,
  ClassificationRecentResponse,
  ClassificationSummary,
} from "@buildinternet/releases-api-types";

export type { ClassificationRecentItem, ClassificationRecentResponse, ClassificationSummary };

export type ClassificationOrigin = ClassificationSummary["origin"];
export type ClassificationBucket = ClassificationSummary["bucket"];
export type ClassificationHistogram = ClassificationSummary["probability"]["selected"];
export type ClassificationChoiceSeriesPoint = ClassificationSummary["choiceSeries"][number];
export type ClassificationSeriesPoint = ClassificationSummary["series"][number];
