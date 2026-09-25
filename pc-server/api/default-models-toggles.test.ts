// api/default-models-toggles.test.ts — settings/default-models 的快速模型子功能开关持久化锁。
// 开关(快速模型卡 Prompt 页的启停)必须随端点落库;非布尔值与缺省键不得覆盖现值
// (老前端/其他调用方不回传布尔时现值保持)。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-default-models-test-"));

import type { State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { handleSettingsRoutes } from "./handlers/settings";

async function postDefaultModels(body: Record<string, unknown>): Promise<Response | null> {
  const url = new URL("http://127.0.0.1/api/settings/default-models");
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleSettingsRoutes(request, url, "settings/default-models");
}

beforeAll(() => {
  setState({
    settings: {
      enableSuggestion: true,
      titleGenerationEnabled: true,
    },
  } as unknown as State);
});

describe("settings/default-models 子功能开关持久化", () => {
  test("布尔值落库:两开关可关", async () => {
    const res = await postDefaultModels({ enableSuggestion: false, titleGenerationEnabled: false });
    expect(res?.status).toBe(200);
    expect(state.settings.enableSuggestion).toBe(false);
    expect(state.settings.titleGenerationEnabled).toBe(false);
  });

  test("缺省键不动现值:只回传一个开关时另一个保持", async () => {
    const res = await postDefaultModels({ enableSuggestion: true });
    expect(res?.status).toBe(200);
    expect(state.settings.enableSuggestion).toBe(true);
    expect(state.settings.titleGenerationEnabled).toBe(false);
  });

  test("非布尔值被拒绝消化(不覆盖现值)", async () => {
    const res = await postDefaultModels({ enableSuggestion: "yes", titleGenerationEnabled: 1 });
    expect(res?.status).toBe(200);
    expect(state.settings.enableSuggestion).toBe(true);
    expect(state.settings.titleGenerationEnabled).toBe(false);
  });
});
