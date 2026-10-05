import { describe, expect, test } from "bun:test";
import { collectCursorPages, cursorPages } from "./cursor-pages";

type Page = { items: number[]; pagination: { nextCursor: string | null } };

describe("cursorPages", () => {
  test("follows nextCursor until it is null", async () => {
    const pages: Record<string, Page> = {
      start: { items: [1, 2], pagination: { nextCursor: "p2" } },
      p2: { items: [3], pagination: { nextCursor: null } },
    };
    const calls: (string | undefined)[] = [];
    const items = await collectCursorPages(
      async (cursor) => {
        calls.push(cursor);
        return pages[cursor ?? "start"]!;
      },
      (p) => p.items,
    );
    expect(items).toEqual([1, 2, 3]);
    expect(calls).toEqual([undefined, "p2"]);
  });

  test("stops on a repeating cursor instead of looping", async () => {
    let n = 0;
    const fetchPage = async (): Promise<Page> => {
      n++;
      return { items: [n], pagination: { nextCursor: "same" } };
    };
    expect(await collectCursorPages(fetchPage, (p) => p.items)).toEqual([1, 2]);
  });

  test("respects maxPages", async () => {
    let n = 0;
    const fetchPage = async (): Promise<Page> => {
      n++;
      return { items: [n], pagination: { nextCursor: `c${n}` } };
    };
    const seen: number[] = [];
    for await (const page of cursorPages(fetchPage, 3)) seen.push(...page.items);
    expect(seen).toEqual([1, 2, 3]);
  });
});
