import { nanoid } from "nanoid";

export const newSourceId = () => `src_${nanoid()}`;
export const newReleaseId = () => `rel_${nanoid()}`;
export const newOrgId = () => `org_${nanoid()}`;
export const newOrgAccountId = () => `oa_${nanoid()}`;
export const newFetchLogId = () => `fl_${nanoid()}`;
export const newIgnoredUrlId = () => `iu_${nanoid()}`;
export const newBlockedUrlId = () => `bu_${nanoid()}`;
export const newSummaryId = () => `sum_${nanoid()}`;
export const newMediaAssetId = () => `ma_${nanoid()}`;
