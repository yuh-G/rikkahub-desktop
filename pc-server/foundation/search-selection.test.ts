// search-selection.test.ts — 删除搜索服务后全局当前服务的去向(前后端共用的唯一口径)。
import { describe, expect, test } from "bun:test";

import { searchSelectionAfterDelete } from "./search-selection";

const list = (...ids: string[]) => ids.map((id) => ({ id }));

describe("searchSelectionAfterDelete", () => {
  test("删当前服务之前的项:当前服务不变,下标前移", () => {
    expect(searchSelectionAfterDelete(list("a", "b", "c"), 2, "a")).toBe(1);
  });

  test("删当前服务之后的项:下标不变", () => {
    expect(searchSelectionAfterDelete(list("a", "b", "c"), 0, "c")).toBe(0);
  });

  test("删的正是当前服务:落到补位的下一项,末尾则前一项", () => {
    expect(searchSelectionAfterDelete(list("a", "b", "c"), 1, "b")).toBe(1);
    expect(searchSelectionAfterDelete(list("a", "b", "c"), 2, "c")).toBe(1);
  });

  test("删空或 id 不存在时不越界", () => {
    expect(searchSelectionAfterDelete(list("a"), 0, "a")).toBe(0);
    expect(searchSelectionAfterDelete(list("a", "b"), 5, "zzz")).toBe(1);
  });
});
