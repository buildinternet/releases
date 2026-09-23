import { cache } from "react";
import { api } from "@/lib/api";

export const getResolved = cache((orgSlug: string, slug: string) => api.resolve({ orgSlug, slug }));
