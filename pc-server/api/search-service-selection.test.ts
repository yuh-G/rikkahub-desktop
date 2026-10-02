// api/search-service-selection.test.ts — 设置页对搜索服务的增删不劫持「对话正在用的搜索服务」。
// 当前服务只由主界面搜索选择器(settings/search/service)切换;新建只追加,删除时当前服务
// 仍在则跟着它走(下标随删除前移),删的正是它才换到补位项。
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-search-selection-test-"));

import type { State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { handleSettingsRoutes } from "./handlers/settings";

function call(method: string, path: string, body?: unknown) {
  const url = new URL(`http://127.0.0.1/api/${path}`);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return handleSettingsRoutes(new Request(url, init), url, path);
}

beforeEach(() => {
  setState({
    settings: {
      searchServices: ["a", "b", "c", "d"].map((id) => ({ id, type: "tavily", name: id })),
      searchServiceSelected: 2,
      dismissedSearchServiceTypes: [],
    },
  } as unknown as State);
});

describe("搜索服务增删与全局当前服务", () => {
  test("新建服务不改当前服务", async () => {
    const res = await call("POST", "settings/search/service/detail", { id: "e", type: "exa", name: "e" });
    expect(res?.status).toBe(200);
    expect(state.settings.searchServices).toHaveLength(5);
    expect(state.settings.searchServiceSelected).toBe(2);
  });

  test("删除当前服务之前的项,当前服务仍是同一个", async () => {
    const res = await call("DELETE", "settings/search/service/a");
    expect(res?.status).toBe(200);
    const current = state.settings.searchServices[state.settings.searchServiceSelected] as { id: string };
    expect(current.id).toBe("c");
  });

  test("删除当前服务,落到补位项", async () => {
    await call("DELETE", "settings/search/service/c");
    const current = state.settings.searchServices[state.settings.searchServiceSelected] as { id: string };
    expect(current.id).toBe("d");
  });
});
