// api/origin-relay.e2e.test.ts — 真实 server.ts 子进程的 origin 接力全链路(阶段1验收锁):
// 预置记录 + --ui-shell 启动 → 三行标记顺序正确 → 旧 origin 出接力页 → POST 收数 →
// 带凭证落地拿到注入数据块 → 记录写成当前 origin → 凭证重放失效 → 临时监听关闭。
// 端口一律从 OS 分配端口派生,绝不碰真实默认端口。落地注入的「响应体」断言仅在静态根
// 存在时执行(CI 的 pc-server 测试不预构建 web-ui;落地判定/记录/一次性不依赖构建产物)。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RELAY_POST_PATH, RELAY_QUERY_KEY, serializeUiOriginRecord } from "../foundation/origin-relay";
import { readUiOriginRecord } from "./origin-relay";
import { resolveStaticRoot } from "./static";

const serverEntry = join(import.meta.dir, "..", "server.ts");

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

function spawnServer(args: string[], dataDir: string) {
  return Bun.spawn(["bun", serverEntry, ...args, "--no-open"], {
    env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
}

interface StartupMarkers {
  uiOrigin: string;
  uiEntry: string;
  port: number;
  acc: string;
}

/** 收集三行启动标记(UI_ORIGIN / UI_ENTRY / PORT,顺序由服务端保证)。 */
async function waitStartupMarkers(proc: ReturnType<typeof Bun.spawn>, timeoutMs = 20_000): Promise<StartupMarkers> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let acc = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    if (/RIKKAHUB_PORT:\d+/.test(acc)) break;
  }
  reader.releaseLock();
  const port = Number(/RIKKAHUB_PORT:(\d+)/.exec(acc)?.[1]);
  const uiOrigin = /RIKKAHUB_UI_ORIGIN:(\S+)/.exec(acc)?.[1] ?? "";
  const uiEntry = /RIKKAHUB_UI_ENTRY:(\S+)/.exec(acc)?.[1] ?? "";
  if (!port || !uiOrigin || !uiEntry) throw new Error(`启动标记不完整,输出:\n${acc.slice(0, 2000)}`);
  // 顺序契约:UI_* 两行都在端口标记之前
  expect(acc.indexOf("RIKKAHUB_UI_ORIGIN:")).toBeLessThan(acc.indexOf("RIKKAHUB_PORT:"));
  expect(acc.indexOf("RIKKAHUB_UI_ENTRY:")).toBeLessThan(acc.indexOf("RIKKAHUB_PORT:"));
  return { uiOrigin, uiEntry, port, acc };
}

async function probeClosed(url: string): Promise<"alive" | "closed"> {
  return fetch(url, { headers: { "sec-fetch-dest": "document" } }).then(() => "alive" as const, () => "closed" as const);
}

function presetRecord(dataDir: string, origin: string): void {
  writeFileSync(join(dataDir, "ui-origin.json"), serializeUiOriginRecord(origin, Date.now()), "utf8");
}

/** Windows 下刚 kill 的子进程可能还攥着 data 目录句柄几百毫秒,rmSync 会 EBUSY——
 *  小睡重试;仍失败就留给 OS 临时目录清理(此时断言已全部完成,残留不影响结论)。 */
function cleanupTempDir(dir: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt >= 5) return;
      Bun.sleepSync(150);
    }
  }
}

describe("界面 origin 接力(真实服务端)", () => {
  test("主链路:标记顺序 → 接力页 → POST → 带凭证落地注入 → 记录 → 一次性 → 关闭", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rkh-relay-e2e-"));
    const Q = freePort();
    const P = freePort();
    presetRecord(dataDir, `http://localhost:${Q}`);
    const proc = spawnServer(["--port", String(P), "--ui-shell"], dataDir);
    try {
      const markers = await waitStartupMarkers(proc);
      expect(markers.uiOrigin).toBe(`http://localhost:${P}`);
      expect(markers.uiEntry).toBe(`http://localhost:${Q}/`);
      expect(markers.acc).toContain("[startup] UI origin relay armed");

      // 旧 origin 上的接力页(视觉即启动屏,含写死的 nonce)
      const page = await fetch(`http://localhost:${Q}/`, { headers: { "sec-fetch-dest": "document" } });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("window.__RIKKAHUB_RELAY__=1");
      const nonce = /,n="([^"]+)"/.exec(html)?.[1];
      expect(nonce).toBeTruthy();

      // POST:合法 Origin + nonce → 204
      const post = await fetch(`http://localhost:${Q}${RELAY_POST_PATH}`, {
        method: "POST",
        headers: { origin: `http://localhost:${Q}`, "content-type": "application/json" },
        body: JSON.stringify({ n: nonce, entries: { "rikkahub.container-tabs.v2": "e2e-tabs-state" } }),
      });
      expect(post.status).toBe(204);

      // 带凭证落地:一次性注入(CI 无 web-ui 构建时跳过响应体断言,记录/一次性仍锁)
      const hasStaticRoot = resolveStaticRoot() !== null;
      const landing = await fetch(`http://localhost:${P}/?${RELAY_QUERY_KEY}=${encodeURIComponent(nonce!)}`, {
        headers: { "sec-fetch-dest": "document" },
      });
      expect(landing.status).toBe(200);
      const body = await landing.text();
      if (hasStaticRoot) {
        expect(body).toContain('id="rikkahub-relay"');
        expect(body).toContain("e2e-tabs-state");
      }
      expect(readUiOriginRecord(join(dataDir, "ui-origin.json"))).toBe(`http://localhost:${P}`);

      // 凭证重放:数据一次性,不再注入
      const replay = await fetch(`http://localhost:${P}/?${RELAY_QUERY_KEY}=${encodeURIComponent(nonce!)}`, {
        headers: { "sec-fetch-dest": "document" },
      });
      expect((await replay.text()).includes("e2e-tabs-state")).toBe(false);

      // 落地 1s 后旧 origin 临时监听关闭
      await Bun.sleep(1400);
      expect(await probeClosed(`http://localhost:${Q}/`)).toBe("closed");
    } finally {
      proc.kill();
      cleanupTempDir(dataDir);
    }
  }, 40_000);

  test("无 --ui-shell(无界面消费者)→ 不开临时监听,ENTRY 即最终 origin 根路径", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rkh-relay-e2e-"));
    const Q = freePort();
    const P = freePort();
    presetRecord(dataDir, `http://localhost:${Q}`);
    const proc = spawnServer(["--port", String(P)], dataDir);
    try {
      const markers = await waitStartupMarkers(proc);
      expect(markers.uiOrigin).toBe(`http://localhost:${P}`);
      expect(markers.uiEntry).toBe(`http://localhost:${P}/`);
      expect(await probeClosed(`http://localhost:${Q}/`)).toBe("closed");
    } finally {
      proc.kill();
      cleanupTempDir(dataDir);
    }
  }, 40_000);

  test("旧端口被他人占用 → 接力放弃,ENTRY = 最终 origin,服务正常", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rkh-relay-e2e-"));
    const Q = freePort();
    const P = freePort();
    presetRecord(dataDir, `http://localhost:${Q}`);
    const squatter = Bun.listen({ hostname: "127.0.0.1", port: Q, socket: { data() {} } });
    const proc = spawnServer(["--port", String(P), "--ui-shell"], dataDir);
    // 「origin relay skipped」走 console.warn(stderr),后台汇集以便断言
    let stderrAcc = "";
    void (async () => {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrAcc += decoder.decode(value, { stream: true });
      }
    })().catch(() => {
      // proc.kill() 截断流属正常收尾,汇集到哪算哪。
    });
    try {
      const markers = await waitStartupMarkers(proc);
      expect(markers.uiEntry).toBe(`http://localhost:${P}/`);
      await Bun.sleep(150);
      expect(stderrAcc).toContain("origin relay skipped");
      // 主服务照常
      const status = await fetch(`http://localhost:${P}/api/startup/status`);
      expect(status.status).toBe(200);
      // 记录未动(没落地):仍是旧值,下次启动还会重试接力
      expect(readUiOriginRecord(join(dataDir, "ui-origin.json"))).toBe(`http://localhost:${Q}`);
    } finally {
      proc.kill();
      squatter.stop(true);
      cleanupTempDir(dataDir);
    }
  }, 40_000);
});
