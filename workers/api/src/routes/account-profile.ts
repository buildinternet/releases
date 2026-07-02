import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createDb } from "../db.js";
import { avatarRejectToError, ingestAvatarFromBuffer } from "../lib/avatar-ingest.js";
import { user } from "../db/schema-auth.js";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import {
  UnauthorizedError,
  ServiceUnavailableError,
  ValidationError,
} from "@releases/lib/releases-error";

const MAX_MULTIPART_BYTES = 8 * 1024 * 1024;

async function readAvatarFile(c: {
  req: { formData: () => Promise<FormData> };
}): Promise<
  { buf: ArrayBuffer; contentType: string } | { error: string; status: 400 | 413 | 415 }
> {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return { error: "Invalid multipart body", status: 400 };
  }
  const entry = form.get("file");
  if (!(entry instanceof File)) {
    return { error: "file is required", status: 400 };
  }
  if (entry.size > MAX_MULTIPART_BYTES) {
    return { error: `Image exceeds the ${MAX_MULTIPART_BYTES}-byte cap`, status: 413 };
  }
  const contentType = (entry.type || "application/octet-stream")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  return { buf: await entry.arrayBuffer(), contentType };
}

export const accountProfileHandlers = new Hono<Env>();

accountProfileHandlers.post("/me/avatar", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  if (!c.env.MEDIA) {
    return respondError(c, new ServiceUnavailableError("Media storage is not configured"));
  }

  const file = await readAvatarFile(c);
  if ("error" in file) {
    return respondError(
      c,
      new ValidationError(file.error, {
        code: file.status === 413 ? "payload_too_large" : "bad_request",
      }),
    );
  }

  const result = await ingestAvatarFromBuffer({
    buf: file.buf,
    contentType: file.contentType,
    keyStem: `users/${session.user.id}`,
    bucket: c.env.MEDIA,
    mediaOrigin: c.env.MEDIA_ORIGIN ?? "https://media.releases.sh",
    component: "user-avatar",
  });
  if (!result.ok) return respondError(c, avatarRejectToError(result));

  const db = createDb(c.env.DB);
  await db.update(user).set({ image: result.avatarUrl }).where(eq(user.id, session.user.id));

  return c.json({
    avatarUrl: result.avatarUrl,
    key: result.key,
    width: result.width,
    height: result.height,
  });
});
