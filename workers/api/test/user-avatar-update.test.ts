import { test, expect } from "bun:test";
import { preserveCustomAvatarOnUpdate } from "../src/lib/avatar-ingest.js";

test("preserveCustomAvatarOnUpdate strips provider image when a hosted avatar exists", () => {
  const res = preserveCustomAvatarOnUpdate(
    { image: "https://lh3.googleusercontent.com/x", name: "Ada" },
    "https://media.releases.sh/users/u1.png",
    "https://media.releases.sh",
  );
  expect(res).toEqual({ data: { name: "Ada" } });
});

test("preserveCustomAvatarOnUpdate is a no-op without a hosted avatar", () => {
  expect(
    preserveCustomAvatarOnUpdate(
      { image: "https://lh3.googleusercontent.com/x" },
      "https://lh3.googleusercontent.com/old",
      "https://media.releases.sh",
    ),
  ).toBeUndefined();
});
