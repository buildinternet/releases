import { cache } from "react";
import { api } from "@/lib/api";

export const getSourceById = cache((id: string) => api.sourceById(id));
