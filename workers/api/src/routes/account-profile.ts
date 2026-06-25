import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createDb } from "../db.js";
import { ingestAvatarFromBuffer } from "../lib/avatar-ingest.js";
import { user } from "../db/schema-auth.js";
import type { Env } from "../index.js";

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
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  if (!c.env.MEDIA) {
    return c.json({ error: "unavailable", message: "Media storage is not configured" }, 503);
  }

  const file = await readAvatarFile(c);
  if ("error" in file) {
    return c.json({ error: "bad_request", message: file.error }, file.status);
  }

  const result = await ingestAvatarFromBuffer({
    buf: file.buf,
    contentType: file.contentType,
    keyStem: `users/${session.user.id}`,
    bucket: c.env.MEDIA,
    mediaOrigin: c.env.MEDIA_ORIGIN ?? "https://media.releases.sh",
    component: "user-avatar",
  });
  if (!result.ok) {
    return c.json({ error: result.error, message: result.message }, result.status);
  }

  const db = createDb(c.env.DB);
  await db.update(user).set({ image: result.avatarUrl }).where(eq(user.id, session.user.id));

  return c.json({
    avatarUrl: result.avatarUrl,
    key: result.key,
    width: result.width,
    height: result.height,
  });
});
