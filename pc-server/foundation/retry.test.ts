// foundation/retry.test.ts — withRetry / RetryableHttpError 行为锁定(台账 §4.3)

import { describe, expect, test } from "bun:test";
import {
  RetryableHttpError,
  isRetryableHttpError,
  isRetryableHttpStatus,
  withRetry,
} from "./retry";

describe("isRetryableHttpStatus(对齐 Android TTSProviderException.isRetryable)", () => {
  test("408/429/5xx 可重试", () => {
    expect(isRetryableHttpStatus(408)).toBe(true);
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(502)).toBe(true);
    expect(isRetryableHttpStatus(599)).toBe(true);
  });
  test("确定性错误不重试(400/401/403/404/422)", () => {
    for (const s of [400, 401, 403, 404, 422]) expect(isRetryableHttpStatus(s)).toBe(false);
  });
  test("2xx/3xx 不在重试域(本就不该作为错误传入)", () => {
    expect(isRetryableHttpStatus(200)).toBe(false);
    expect(isRetryableHttpStatus(301)).toBe(false);
  });
});

describe("RetryableHttpError", () => {
  test("携带 statusCode 并按其暴露 isRetryable", () => {
    expect(new RetryableHttpError("rate", 429).isRetryable).toBe(true);
    expect(new RetryableHttpError("bad key", 401).isRetryable).toBe(false);
    expect(new RetryableHttpError("boom", 500).statusCode).toBe(500);
  });
});

describe("isRetryableHttpError", () => {
  test("HTTP 错误按状态码", () => {
    expect(isRetryableHttpError(new RetryableHttpError("x", 503))).toBe(true);
    expect(isRetryableHttpError(new RetryableHttpError("x", 400))).toBe(false);
  });
  test("网络瞬断(无状态码)一律可重试", () => {
    expect(isRetryableHttpError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableHttpError(new Error("ECONNRESET"))).toBe(true);
  });
});

describe("withRetry", () => {
  test("首次成功:不重试,返回结果", async () => {
    let calls = 0;
    const out = await withRetry(() => {
      calls += 1;
      return Promise.resolve("ok");
    });
    expect(out).toBe("ok");
    expect(calls).toBe(1);
  });

  test("可重试错退避后成功:按 500→1000 各一次,共 3 次尝试", async () => {
    let calls = 0;
    const delays: number[] = [];
    const started = Date.now();
    const out = await withRetry(
      () => {
        calls += 1;
        if (calls < 3) return Promise.reject(new RetryableHttpError("rate", 429));
        return Promise.resolve("recovered");
      },
      { onRetry: ({ delayMs }) => delays.push(delayMs) },
    );
    expect(out).toBe("recovered");
    expect(calls).toBe(3);
    expect(delays).toEqual([500, 1000]); // 指数退避序列
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400); // 500+1000 余量
  });

  test("确定性错误(400)立即抛出,不重试", async () => {
    let calls = 0;
    await expect(
      withRetry(() => {
        calls += 1;
        return Promise.reject(new RetryableHttpError("bad request", 400));
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toBe(1);
  });

  test("达上限后抛出最后一次错误", async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(new RetryableHttpError("server", 500));
        },
        { maxAttempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(calls).toBe(3);
  });

  test("自定义 shouldRetry 可改写判据", async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(new Error("network"));
        },
        { maxAttempts: 5, baseDelayMs: 1, shouldRetry: () => false },
      ),
    ).rejects.toThrow("network");
    expect(calls).toBe(1); // 即便网络错也被自定义判据拦下
  });

  test("等待中被 abort:以 AbortError 收尾,不再重试", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = withRetry(
      () => {
        calls += 1;
        return Promise.reject(new RetryableHttpError("rate", 429));
      },
      { maxAttempts: 5, baseDelayMs: 10_000, signal: controller.signal },
    );
    // 第一次失败进入长退避等待时打断
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1); // 只跑了首次,长退避没等到就被打断
  });

  test("fn 内部抛 AbortError:视作主动中止,原样抛不重试", async () => {
    let calls = 0;
    await expect(
      withRetry(() => {
        calls += 1;
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  test("onRetry 回报尝试序号与错误", async () => {
    const seen: Array<{ attempt: number; status?: number }> = [];
    await withRetry(
      (attempt) =>
        attempt < 3
          ? Promise.reject(new RetryableHttpError("e", 503))
          : Promise.resolve("done"),
      { onRetry: ({ attempt, error }) => seen.push({ attempt, status: (error as RetryableHttpError).statusCode }) },
    );
    expect(seen).toEqual([
      { attempt: 2, status: 503 },
      { attempt: 3, status: 503 },
    ]);
  });
});
