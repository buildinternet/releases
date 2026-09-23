import { describe, expect, it } from "bun:test";
import { resolvePageWindow, slicePage } from "./pagination.js";

const OPTS = { defaultPageSize: 50, maxPageSize: 200 };

describe("resolvePageWindow", () => {
  it("defaults to page 1 at the default page size", () => {
    expect(resolvePageWindow({}, OPTS)).toEqual({ page: 1, pageSize: 50, offset: 0 });
  });

  it("computes the offset from page and limit", () => {
    expect(resolvePageWindow({ page: 3, limit: 20 }, OPTS)).toEqual({
      page: 3,
      pageSize: 20,
      offset: 40,
    });
  });

  it("caps limit at maxPageSize", () => {
    expect(resolvePageWindow({ limit: 1000 }, OPTS).pageSize).toBe(200);
  });

  it("never lets the default exceed the max", () => {
    expect(resolvePageWindow({}, { defaultPageSize: 500, maxPageSize: 100 }).pageSize).toBe(100);
  });

  it("floors fractional values", () => {
    expect(resolvePageWindow({ page: 2.9, limit: 10.5 }, OPTS)).toEqual({
      page: 2,
      pageSize: 10,
      offset: 10,
    });
  });

  it("falls back on zero, negative, and non-finite values", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolvePageWindow({ page: bad, limit: bad }, OPTS)).toEqual({
        page: 1,
        pageSize: 50,
        offset: 0,
      });
    }
  });
});

describe("slicePage", () => {
  it("returns the window's slice", () => {
    const items = [1, 2, 3, 4, 5];
    expect(slicePage(items, { offset: 2, pageSize: 2 })).toEqual([3, 4]);
    expect(slicePage(items, { offset: 4, pageSize: 2 })).toEqual([5]);
    expect(slicePage(items, { offset: 10, pageSize: 2 })).toEqual([]);
  });
});
