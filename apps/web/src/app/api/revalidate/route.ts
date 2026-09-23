import { revalidatePath } from "next/cache";
import { handleRevalidateRequest } from "@/lib/revalidate-request";
import { serviceKey } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * API worker → web on-demand ISR invalidation. All of the contract (auth, body
 * validation, path derivation) lives in `lib/revalidate-request` so it is
 * testable without `next/cache`; this file only supplies the real dependencies.
 */
export async function POST(req: Request): Promise<Response> {
  return handleRevalidateRequest(req, {
    serviceKey: serviceKey(),
    revalidate: (path) => revalidatePath(path),
  });
}
