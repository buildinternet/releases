import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class merger for overlay primitives in `components/ui`. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
