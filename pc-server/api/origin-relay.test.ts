// api/origin-relay.test.ts — origin 接力 HTTP 面:记录读写 + 协调器全链路(真实套接字,
// 端口一律 OS 分配派生)。落地判定直接喂构造的 Request(主监听不需要真的在场)。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOriginRelayApi, readUiOriginRecord, writeUiOriginRecord } from "./origin-relay";
import { ORIGIN_RELAY_KEYS, RELAY_POST_PATH, RELAY_QUERY_KEY, serializeUiOriginRecord } from "../foundation/origin-relay";

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

function tempRecordPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rkh-origin-relay-")), "ui-origin.json");
}

describe("记录文件读写", () => {
  test("不存在 → null;写入 → 读回;原子写不残留 tmp", () => {
    const recordPath = tempRecordPath();
    expect(readUiOriginRecord(recordPath)).toBeNull();
    writeUiOriginRecord(recordPath, "http://localhost:17455");
    expect(readUiOriginRecord(recordPath)).toBe("http://localhost:17455");
    expect(readFileSync(recordPath, "utf8")).toBe(serializeUiOriginRecord("http://localhost:17455", JSON.parse(readFileSync(recordPath, "utf8")).updatedAt));
    rmSync(join(recordPath, ".."), { recursive: true, force: true });
  });

  test("损坏内容 → null(不抛)", () => {
    const recordPath = tempRecordPath();
    writeFileSync(recordPath, "{broken", "utf8");
    expect(readUiOriginRecord(recordPath)).toBeNull();
    rmSync(join(recordPath, ".."), { recursive: true, force: true });
  });
});

describe("协调器全链路(真实套接字)", () => {
  test("接力页 → POST 校验 → 带凭证落地注入 → 一次性 → 记录 → 临时监听关闭", async () => {
    const recordPath = tempRecordPath();
    const Q = freePort();
    const P = freePort();
    const nonce = "e2e-fixed-nonce-0123456789";
    const fromOrigin = `http://localhost:${Q}`;
    const currentOrigin = `http://localhost:${P}`;
    const api = createOriginRelayApi({
      recordPath,
      currentOrigin,
      recordedOrigin: fromOrigin,
      randomNonce: () => nonce,
    });
    const session = api.startSession(fromOrigin);
    expect(session).not.toBeNull();
    expect(session!.entryUrl).toBe(`${fromOrigin}/`);

    // 接力页:document 请求(含无 Sec-Fetch-Dest 头的老客户端)200、含旗标/nonce;
    // 显式非 document(如页面内 fetch)一律 404——临时监听绝不暴露成普通页面。
    // 注:Bun 的 fetch 客户端本身不发 Sec-Fetch-Dest,无头请求走的是「视作 document」分支。
    const page = await fetch(`http://localhost:${Q}/`, { headers: { "sec-fetch-dest": "document" } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("window.__RIKKAHUB_RELAY__=1");
    expect(html).toContain(JSON.stringify(nonce));
    const headerless = await fetch(`http://localhost:${Q}/`);
    expect(headerless.status).toBe(200);
    const notDoc = await fetch(`http://localhost:${Q}/`, { headers: { "sec-fetch-dest": "empty" } });
    expect(notDoc.status).toBe(404);

    // POST 三连拒:无 Origin / 错 Origin / 错 nonce
    const validBody = JSON.stringify({ n: nonce, entries: { [ORIGIN_RELAY_KEYS[0]]: "tabs-state", evil: "smuggled" } });
    const post = (headers: Record<string, string>, body: string) =>
      fetch(`http://localhost:${Q}${RELAY_POST_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
    expect((await post({}, validBody)).status).toBe(403);
    expect((await post({ origin: "http://evil.example" }, validBody)).status).toBe(403);
    expect((await post({ origin: fromOrigin }, JSON.stringify({ n: "wrong", entries: {} }))).status).toBe(403);

    // 合法 POST → 204;重放 → 410(只收一次)
    expect((await post({ origin: fromOrigin }, validBody)).status).toBe(204);
    expect((await post({ origin: fromOrigin }, validBody)).status).toBe(410);

    // 落地判定:Host 非桌面 origin → 不算落地、不写记录
    const landingUrl = `http://localhost:${P}/?${RELAY_QUERY_KEY}=${nonce}`;
    const foreignHost = new Request(landingUrl, { headers: { "sec-fetch-dest": "document", host: `localhost:${Q}` } });
    expect(api.noteDocumentLanding(foreignHost, new URL(landingUrl))).toBeUndefined();
    expect(readUiOriginRecord(recordPath)).toBeNull();
    // 非 document 也不算落地
    const fetchDest = new Request(landingUrl, { headers: { "sec-fetch-dest": "empty", host: `localhost:${P}` } });
    expect(api.noteDocumentLanding(fetchDest, new URL(landingUrl))).toBeUndefined();
    expect(readUiOriginRecord(recordPath)).toBeNull();

    // 带凭证的桌面落地:注入、白名单过滤(evil 键丢弃)、记录写成当前 origin、一次性
    const landing = new Request(landingUrl, { headers: { "sec-fetch-dest": "document", host: `localhost:${P}` } });
    const injection = api.noteDocumentLanding(landing, new URL(landingUrl));
    expect(injection).toBeDefined();
    expect(injection).toContain(ORIGIN_RELAY_KEYS[0]);
    expect(injection).toContain("tabs-state");
    expect(injection).not.toContain("evil");
    expect(readUiOriginRecord(recordPath)).toBe(currentOrigin);
    expect(api.noteDocumentLanding(landing, new URL(landingUrl))).toBeUndefined();

    // 落地后 1s 临时监听关闭
    await Bun.sleep(1400);
    const gone = await fetch(`http://localhost:${Q}/`, { headers: { "sec-fetch-dest": "document" } }).then(
      () => "alive",
      () => "closed",
    );
    expect(gone).toBe("closed");
    rmSync(join(recordPath, ".."), { recursive: true, force: true });
  }, 20_000);

  test("无凭证落地同样终局:写记录、待取数据作废(不能再被消费)", () => {
    const recordPath = tempRecordPath();
    const Q = freePort();
    const P = freePort();
    const nonce = "abandon-nonce";
    const fromOrigin = `http://localhost:${Q}`;
    const currentOrigin = `http://localhost:${P}`;
    const api = createOriginRelayApi({ recordPath, currentOrigin, recordedOrigin: fromOrigin, randomNonce: () => nonce });
    expect(api.startSession(fromOrigin)).not.toBeNull();

    // 模拟「界面先直达新 origin」(壳兜底/POST 失败):无查询参数的桌面落地
    const plainUrl = `http://localhost:${P}/`;
    const plain = new Request(plainUrl, { headers: { "sec-fetch-dest": "document", host: `localhost:${P}` } });
    expect(api.noteDocumentLanding(plain, new URL(plainUrl))).toBeUndefined();
    expect(readUiOriginRecord(recordPath)).toBe(currentOrigin);

    // 之后才带凭证到达 → 数据已作废,不注入(界面已在新 origin 活动,旧数据过期)
    const late = new Request(`${plainUrl}?${RELAY_QUERY_KEY}=${nonce}`, {
      headers: { "sec-fetch-dest": "document", host: `localhost:${P}` },
    });
    expect(api.noteDocumentLanding(late, new URL(late.url))).toBeUndefined();
    api.stopAll();
    rmSync(join(recordPath, ".."), { recursive: true, force: true });
  });

  test("无会话时桌面落地也写记录(日常启动的记录维护)", () => {
    const recordPath = tempRecordPath();
    const P = freePort();
    const currentOrigin = `http://localhost:${P}`;
    const api = createOriginRelayApi({ recordPath, currentOrigin, recordedOrigin: null });
    const url = `http://localhost:${P}/conversations`;
    const req = new Request(url, { headers: { "sec-fetch-dest": "document", host: `localhost:${P}` } });
    expect(api.noteDocumentLanding(req, new URL(url))).toBeUndefined();
    expect(readUiOriginRecord(recordPath)).toBe(currentOrigin);
    rmSync(join(recordPath, ".."), { recursive: true, force: true });
  });

  test("旧端口被他人占用 → startSession 返回 null(放弃接力,不抛)", () => {
    const recordPath = tempRecordPath();
    const Q = freePort();
    const squatter = Bun.listen({ hostname: "127.0.0.1", port: Q, socket: { data() {} } });
    const api = createOriginRelayApi({ recordPath, currentOrigin: `http://localhost:${freePort()}` });
    expect(api.startSession(`http://localhost:${Q}`)).toBeNull();
    squatter.stop(true);
    rmSync(join(recordPath, ".."), { recursive: true, force: true });
  });
});
