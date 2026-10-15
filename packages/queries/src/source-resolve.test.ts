import { describe, expect, it } from "bun:test";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../tests/db-helper.js";
import { resolveOrgHint, resolveSourceIdentifier } from "./source-resolve.js";

async function seed() {
  const tdb = createTestDb();
  await tdb.db.insert(organizations).values([
    { id: "org_harvey", name: "Harvey", slug: "harvey" },
    { id: "org_firebase", name: "Firebase", slug: "firebase" },
  ]);
  await tdb.db.insert(sources).values([
    {
      id: "src_harvey_notes",
      orgId: "org_harvey",
      name: "Harvey notes",
      slug: "release-notes",
      type: "scrape",
      url: "https://harvey.example/notes",
    },
    {
      id: "src_firebase_notes",
      orgId: "org_firebase",
      name: "Firebase notes",
      slug: "release-notes",
      type: "feed",
      url: "https://firebase.example/notes",
    },
    {
      id: "src_harvey_only",
      orgId: "org_harvey",
      name: "Harvey only",
      slug: "platform",
      type: "scrape",
      url: "https://harvey.example/platform",
    },
  ]);
  return tdb.db;
}

describe("resolveSourceIdentifier", () => {
  it("scopes a bare slug to the named org and does not fall back to another org", async () => {
    const db = await seed();
    const harvey = await resolveOrgHint(db, "harvey");
    const resolved = await resolveSourceIdentifier(db, "release-notes", { org: harvey });
    expect(resolved.status).toBe("found");
    if (resolved.status === "found") {
      expect(resolved.source.id).toBe("src_harvey_notes");
      expect(resolved.via).toBe("org");
    }

    const missing = await resolveSourceIdentifier(db, "platform", {
      org: await resolveOrgHint(db, "firebase"),
    });
    expect(missing.status).toBe("not_found");
  });

  it("rejects an ambiguous bare slug when no org is named", async () => {
    const db = await seed();
    const resolved = await resolveSourceIdentifier(db, "release-notes");
    expect(resolved.status).toBe("ambiguous");
    if (resolved.status === "ambiguous") {
      expect(resolved.candidates.map((c) => c.orgSlug)).toEqual(["firebase", "harvey"]);
    }
  });

  it("resolves a unique bare slug and a typed id", async () => {
    const db = await seed();
    const bare = await resolveSourceIdentifier(db, "platform");
    expect(bare.status).toBe("found");
    if (bare.status === "found") expect(bare.via).toBe("bare-slug");

    const byId = await resolveSourceIdentifier(db, "src_firebase_notes", {
      org: await resolveOrgHint(db, "Harvey"),
    });
    expect(byId.status).toBe("org_mismatch");

    const owned = await resolveSourceIdentifier(db, "src_harvey_notes", {
      org: await resolveOrgHint(db, "harvey"),
    });
    expect(owned.status).toBe("found");
  });

  it("rejects a coordinate that names a different org than the hint", async () => {
    const db = await seed();
    const resolved = await resolveSourceIdentifier(db, "firebase/release-notes", {
      org: await resolveOrgHint(db, "harvey"),
    });
    expect(resolved.status).toBe("org_mismatch");
  });
});
