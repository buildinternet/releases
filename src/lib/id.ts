import { nanoid } from "nanoid";

export const newSourceId = () => `src_${nanoid()}`;
export const newReleaseId = () => `rel_${nanoid()}`;
