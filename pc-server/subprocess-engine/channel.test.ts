// subprocess-engine/channel.test.ts — 引擎宿主专用通道:路径规则、令牌、只收一个连接(P7.2.2)
// 本机实跑的是当前平台(Windows 具名管道 / Linux CI 的 Unix 域套接字);路径规则是纯函数,三个平台都在这里测。
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";

import { connectEngineChannel, engineChannelPath, listenEngineChannel } from "./channel";
import { encodeFrame } from "./frames";

const id = "0123456789abcdef0123456789abcdef";

describe("通道路径", () => {
  test("Windows 是具名管道", () => {
    expect(engineChannelPath("win32", id, "")).toBe(`\\\\.\\pipe\\rikkahub-engine-${id}-sock`);
  });

  test("Linux / mac 是目录里的套接字文件;总长不超过 107 / 103,超了截短随机部分", () => {
    expect(engineChannelPath("linux", id, "/run/user/1000")).toBe(`/run/user/1000/rikkahub-engine-${id}.sock`);
    const longDir = `/var/folders/${"a".repeat(40)}/T/rkh-x`;
    const mac = engineChannelPath("darwin", id, longDir);
    expect(mac.length).toBeLessThanOrEqual(103);
    expect(mac.startsWith(`${longDir}/rikkahub-engine-`) && mac.endsWith(".sock")).toBe(true);
    const linux = engineChannelPath("linux", id, `/tmp/${"b".repeat(70)}`);
    expect(linux.length).toBeLessThanOrEqual(107);
  });

  test("目录长到放不下:报错而不是生成一个连不上的路径", () => {
    expect(() => engineChannelPath("darwin", id, `/${"c".repeat(100)}`)).toThrow("路径太长");
  });
});

/** 不经 connectEngineChannel,直接连上去发一帧(模拟不知道令牌的进程)。 */
function rawConnect(address: string, firstFrame: string | null): Promise<"closed"> {
  return new Promise((resolve) => {
    const socket = createConnection(address);
    socket.on("connect", () => {
      if (firstFrame !== null) socket.write(encodeFrame(firstFrame));
    });
    socket.on("error", () => {
      // 被对端断开时 Windows 可能报 EPIPE / ECONNRESET:与 close 同义
    });
    socket.on("close", () => resolve("closed"));
  });
}

describe("监听与连接(实跑)", () => {
  test("令牌对的连接被接受,双向收发;接受后监听收起,套接字文件删掉、再连连不上", async () => {
    const listener = await listenEngineChannel();
    const child = await connectEngineChannel(listener.address, { token: listener.token, role: "engine-host" });
    const { channel, hello } = await listener.accepted;
    expect(hello.role).toBe("engine-host");

    const toParent: string[] = [];
    const toChild: string[] = [];
    channel.onFrame((text) => toParent.push(text));
    child.onFrame((text) => toChild.push(text));
    child.send("从宿主来");
    channel.send("从主程序来");
    const big = "大".repeat(2_000_000);
    child.send(big);
    for (let i = 0; i < 200 && (toParent.length < 2 || toChild.length < 1); i++) await Bun.sleep(10);
    expect(toParent).toEqual(["从宿主来", big]);
    expect(toChild).toEqual(["从主程序来"]);
    child.setPeerMaxFrameBytes(16);
    expect(() => child.send("x".repeat(17))).toThrow("单帧上限");
    child.send("x".repeat(16));
    for (let i = 0; i < 100 && toParent.length < 3; i++) await Bun.sleep(10);
    expect(toParent[2]).toBe("x".repeat(16));

    // Windows:监听收起后,已接受的那条连接仍占着同名管道的唯一实例,新的连接会等满 30 秒才被拒绝,这里不实测
    if (process.platform !== "win32") {
      expect(existsSync(listener.address)).toBe(false);
      expect(await rawConnect(listener.address, null)).toBe("closed");
    }

    const closed = new Promise<string>((resolve) => channel.onClose(resolve));
    child.close();
    expect(await closed).toBe("对端已断开");
  });

  test("令牌不对、第一帧不是 JSON:连接被断开,随后令牌对的连接照常接受", async () => {
    const listener = await listenEngineChannel();
    expect(await rawConnect(listener.address, JSON.stringify({ token: "wrong" }))).toBe("closed");
    expect(await rawConnect(listener.address, "not json")).toBe("closed");
    const child = await connectEngineChannel(listener.address, { token: listener.token });
    const { channel } = await listener.accepted;
    channel.close();
    child.close();
  });

  test("限时内没人连上:accepted 以错误拒绝;提前收起也拒绝", async () => {
    const slow = await listenEngineChannel({ timeoutMs: 50 });
    await expect(slow.accepted).rejects.toThrow("没有连上通道");
    const early = await listenEngineChannel();
    early.close();
    await expect(early.accepted).rejects.toThrow("已收起");
  });
});
