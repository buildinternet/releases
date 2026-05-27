import { cache } from "react";
import { api } from "@/lib/api";

export const getSource = cache((orgSlug: string, sourceSlug: string) =>
  api.sourceDetail({ orgSlug, sourceSlug }),
);
