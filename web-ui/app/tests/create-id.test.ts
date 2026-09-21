// create-id.test.ts — createId() secure-context 治本回归锁(issue #55/#56)
import { afterEach, describe, expect, test } from "bun:test";
import { createId } from "~/lib/id";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Bun 测试进程里 crypto.randomUUID 可用(非浏览器 insecure context);这里用临时替换
// globalThis.crypto 模拟「非安全上下文」形态,验证回退链不崩且仍产唯一合法 id。
const originalCrypto = globalThis.crypto;
afterEach(() => {
  Object.defineProperty(globalThis, "crypto", { value: originalCrypto, configurable: true, writable: true });
});

function stubCrypto(impl: Partial<Crypto> | undefined) {
  Object.defineProperty(globalThis, "crypto", { value: impl, configurable: true, writable: true });
}

describe("createId", () => {
  test("默认(randomUUID 可用)产合法 v4 UUID 且两次不等", () => {
    const a = createId();
    const b = createId();
    expect(a).toMatch(UUID_V4);
    expect(a).not.toBe(b);
  });

  test("非安全上下文(randomUUID 缺失,getRandomValues 在)走回退仍合法唯一", () => {
    stubCrypto({ getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) } as Partial<Crypto>);
    const a = createId();
    const b = createId();
    expect(a).toMatch(UUID_V4);
    expect(a).not.toBe(b);
  });

  test("crypto 整体缺失(极端)兜底 Math.random 仍产 v4 形态唯一串", () => {
    stubCrypto(undefined);
    const a = createId();
    const b = createId();
    expect(a).toMatch(UUID_V4);
    expect(a).not.toBe(b);
  });
});
