// api/restore-report.test.ts — DELETE data/restore-report 清除上次云端恢复的降级报告(「知道了」)。
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-restore-report-test-"));

import type { State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { handleDataRoutes } from "./handlers/data";

async function dismiss(): Promise<Response | null> {
  const url = new URL("http://127.0.0.1/api/data/restore-report");
  return handleDataRoutes(new Request(url, { method: "DELETE" }), url, "data/restore-report");
}

beforeEach(() => {
  setState({
    settings: {
      lastRestoreReport: {
        finishedAt: "2026-10-03T00:00:00.000Z",
        source: "webdav",
        filesDeduped: 0,
        dbReadError: null,
        messageNodesUnreadable: 3,
      },
    },
  } as unknown as State);
});

describe("data/restore-report", () => {
  test("清除报告", async () => {
    const res = await dismiss();
    expect(res?.status).toBe(200);
    expect(state.settings.lastRestoreReport).toBeNull();
  });

  test("没有报告时幂等", async () => {
    await dismiss();
    const res = await dismiss();
    expect(res?.status).toBe(200);
    expect(state.settings.lastRestoreReport).toBeNull();
  });
});
