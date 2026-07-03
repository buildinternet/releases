import { describe, expect, test } from "bun:test";
import { MigrationNotes } from "./release-content";

// Logic-level check for the migration-notes block (#1710): renders nothing on
// absent/blank input, renders an element when notes are present. No DOM
// harness — the component returns null / a React element directly.
describe("MigrationNotes", () => {
  test("renders null for absent or blank notes", () => {
    expect(MigrationNotes({ notes: null })).toBeNull();
    expect(MigrationNotes({ notes: undefined })).toBeNull();
    expect(MigrationNotes({})).toBeNull();
    expect(MigrationNotes({ notes: "   " })).toBeNull();
  });

  test("renders an element when notes are present", () => {
    expect(MigrationNotes({ notes: "Rename config before upgrading." })).not.toBeNull();
  });
});
