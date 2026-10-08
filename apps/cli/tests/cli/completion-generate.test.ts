import { describe, it, expect } from "bun:test";
import {
  generateBashCompletion,
  generateZshCompletion,
  generateFishCompletion,
  type CommandSpec,
} from "../../src/cli/completion/generate.js";

const FIXTURE: CommandSpec = {
  name: "releases",
  description: "Changelog indexer",
  options: [{ flags: ["-h", "--help"], description: "Display help" }],
  children: [
    {
      name: "search",
      description: "Full-text search across releases",
      options: [{ flags: ["--json"], description: "JSON output" }],
      children: [],
    },
    {
      name: "admin",
      description: "Operator workflows",
      options: [],
      children: [
        {
          name: "source",
          description: "Manage sources",
          options: [],
          children: [
            {
              name: "create",
              description: "Create a source",
              options: [{ flags: ["--priority"], description: "Tier" }],
              children: [],
            },
            {
              name: "update",
              description: "Update a source",
              options: [],
              children: [],
            },
          ],
        },
      ],
    },
  ],
};

describe("generateBashCompletion", () => {
  it("starts with a function definition and a complete -F line", () => {
    const out = generateBashCompletion(FIXTURE);
    expect(out).toContain("_releases()");
    expect(out).toContain("complete -F _releases releases");
  });

  it("includes every command path in the case statement", () => {
    const out = generateBashCompletion(FIXTURE);
    // root-level: search, admin
    expect(out).toMatch(/"\s*"\)[\s\S]*?search admin/);
    // admin level
    expect(out).toContain('"admin")');
    expect(out).toMatch(/"admin"\)[\s\S]*?source/);
    // nested
    expect(out).toContain('"admin source")');
    expect(out).toMatch(/"admin source"\)[\s\S]*?create update/);
  });

  it("skips dashed args when building path (so flags don't break completion)", () => {
    const out = generateBashCompletion(FIXTURE);
    expect(out).toContain("!= -*");
  });
});

describe("generateZshCompletion", () => {
  it("starts with #compdef and ends wiring the function", () => {
    const out = generateZshCompletion(FIXTURE);
    expect(out.startsWith("#compdef releases")).toBe(true);
    expect(out).toContain("compdef _releases releases");
  });

  it("emits descriptions in zsh _describe format (name:desc)", () => {
    const out = generateZshCompletion(FIXTURE);
    expect(out).toContain("'search:Full-text search across releases'");
    expect(out).toContain("'admin:Operator workflows'");
  });

  it("emits a case branch per path with children", () => {
    const out = generateZshCompletion(FIXTURE);
    expect(out).toContain('"")');
    expect(out).toContain('"admin")');
    expect(out).toContain('"admin source")');
  });

  it("escapes single quotes in descriptions", () => {
    const tricky: CommandSpec = {
      name: "releases",
      description: "",
      options: [],
      children: [{ name: "foo", description: "it's tricky", options: [], children: [] }],
    };
    const out = generateZshCompletion(tricky);
    expect(out).toContain("'foo:it'\\''s tricky'");
  });
});

describe("generateFishCompletion", () => {
  it("uses fish complete -c syntax", () => {
    const out = generateFishCompletion(FIXTURE);
    expect(out).toContain("complete -c releases");
  });

  it("uses __fish_use_subcommand for top-level commands", () => {
    const out = generateFishCompletion(FIXTURE);
    expect(out).toContain("__fish_use_subcommand");
    expect(out).toMatch(/-a 'search'.*Full-text search/);
    expect(out).toMatch(/-a 'admin'.*Operator workflows/);
  });

  it("uses __fish_seen_subcommand_from for nested commands", () => {
    const out = generateFishCompletion(FIXTURE);
    expect(out).toContain("__fish_seen_subcommand_from admin");
    expect(out).toMatch(/-a 'source'.*Manage sources/);
  });

  it("escapes single quotes in fish descriptions", () => {
    const tricky: CommandSpec = {
      name: "releases",
      description: "",
      options: [],
      children: [{ name: "foo", description: "it's tricky", options: [], children: [] }],
    };
    const out = generateFishCompletion(tricky);
    expect(out).toContain("'it\\'s tricky'");
  });
});
