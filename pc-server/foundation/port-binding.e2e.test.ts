// issue #62 产品级回归锁:真实 server.ts 子进程的回环整组占有。只占 127.0.0.1 时,第三方在 ::1
// 上的监听会接走 localhost 的界面流量而顺延察觉不到;现在两扇门必须都由我们应答,::1 被占必须
// 整组顺延,且顺延时已绑的 127.0.0.1 被回滚释放。
import { waitForServerReady } from "../test-utils/e2e-server";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeIpv6Loopback } from "./port-binding";

const serverEntry = join(import.meta.dir, "..", "server.ts");

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

function spawnServer(args: string[]) {
  return Bun.spawn(["bun", serverEntry, ...args, "--no-open"], {
    env: { ...process.env, RIKKAHUB_PC_DATA_DIR: mkdtempSync(join(tmpdir(), "rkh-port-binding-e2e-")) },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function statusCode(url: string): Promise<number> {
  try {
    return (await fetch(url)).status;
  } catch {
    return 0;
  }
}

describe.skipIf(!probeIpv6Loopback())("回环整组占有(真实服务端)", () => {
  for (const hostArgs of [[], ["--host", "localhost"]]) {
    test(`${hostArgs.join(" ") || "默认"}:127.0.0.1 与 [::1] 都由我们应答`, async () => {
      const proc = spawnServer(["--port", String(freePort()), ...hostArgs]);
      try {
        const port = await waitForServerReady(proc);
        expect(await statusCode(`http://127.0.0.1:${port}/api/startup/status`)).toBe(200);
        expect(await statusCode(`http://[::1]:${port}/api/startup/status`)).toBe(200);
      } finally {
        proc.kill();
      }
    }, 30_000);
  }

  test("#62:::1:P 已被他人占用 → 整组顺延离开 P,新端口两扇门都通,127.0.0.1:P 已释放", async () => {
    const preferred = freePort();
    const squatter = Bun.listen({ hostname: "::1", port: preferred, socket: { data() {} } });
    const proc = spawnServer(["--port", String(preferred)]);
    try {
      const port = await waitForServerReady(proc);
      expect(port).not.toBe(preferred);
      expect(await statusCode(`http://127.0.0.1:${port}/api/startup/status`)).toBe(200);
      expect(await statusCode(`http://[::1]:${port}/api/startup/status`)).toBe(200);
      // 回滚没释放的话这里会抛 EADDRINUSE
      Bun.listen({ hostname: "127.0.0.1", port: preferred, socket: { data() {} } }).stop(true);
    } finally {
      proc.kill();
      squatter.stop(true);
    }
  }, 30_000);
});
