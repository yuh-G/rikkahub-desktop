// tools/mcp-health.test.ts — 决策④行为锁:故障分类 + 结构化诊断回灌(单一事实源,双引擎共用)
//
// 钉住三条契约:
//   1) classifyMcpFailure 把开发者向报错归一到机器可读的 kind/retryable/action,
//      且"可自救性"判定正确(授权过期/配置错误恒不可自救,网络瞬态可自救);
//   2) mcpToolFailureError 渲染成单行头 + 尾部 cause 的结构化诊断文本——模型靠头决策,
//      原始细节在尾部备查;MCP_TOOL_FAILURE 前缀是前端失败卡的识别锚点;
//   3) 诊断与工具/引擎无关:它是纯函数,对话引擎与 pi 引擎经同一 executeToolCall 入口
//      自动继承,未来新引擎零成本接入(架构边界:本模块不 import 任何引擎编排器)。

import { describe, expect, test } from "bun:test";

import { classifyMcpFailure, mcpToolFailureError, McpHealthSupervisor, isServerInUse } from "./mcp-health";

describe("classifyMcpFailure — 可自救性判定", () => {
  test("授权过期(401/invalid_token)→ 不可自救,引导用户重新授权", () => {
    for (const err of [
      new Error("401: {\"error\":\"invalid_token\"}"),
      new Error("HTTP 401 Unauthorized"),
      new Error("invalid access token"),
      new Error("401"),
    ]) {
      const cls = classifyMcpFailure(err);
      expect(cls.kind).toBe("auth_expired");
      expect(cls.retryable).toBe(false);
      expect(cls.action).toBe("inform_user_reauthorize");
    }
  });

  test("配置错误(URL 非法/缺失)→ 不可自救,引导用户改配置", () => {
    const cls = classifyMcpFailure(new Error("MCP server URL must be http(s)"));
    expect(cls.kind).toBe("config_error");
    expect(cls.retryable).toBe(false);
    expect(cls.action).toBe("inform_user_fix_config");
  });

  test("网络瞬态(超时/连接重置/拒绝/DNS)→ 可自救,退避重试", () => {
    for (const msg of [
      "MCP request timed out after 30s",
      "connect ETIMEDOUT 140.82.0.1:443",
      "read ECONNRESET",
      "connect ECONNREFUSED 127.0.0.1:8000",
      "getaddrinfo ENOTFOUND mcp.example.com",
      "fetch failed",
    ]) {
      const cls = classifyMcpFailure(new Error(msg));
      expect(cls.kind).toBe("network_transient");
      expect(cls.retryable).toBe(true);
      expect(cls.action).toBe("retry_with_backoff");
    }
  });

  test("HTTP 5xx(服务器侧)→ 可自救(退避重试兜底)", () => {
    const cls = classifyMcpFailure(new Error("HTTP 503 Service Unavailable"));
    expect(cls.kind).toBe("network_transient");
    expect(cls.retryable).toBe(true);
  });

  test("未知错误 → 可自救,建议换工具", () => {
    const cls = classifyMcpFailure(new Error("some opaque failure"));
    expect(cls.kind).toBe("unknown");
    expect(cls.retryable).toBe(true);
    expect(cls.action).toBe("try_alternative_tool");
  });

  test("嵌套 cause 链参与分类(err.cause 递归拼进 message)", () => {
    const inner = new Error("invalid_token");
    const outer = new Error("request failed", { cause: inner });
    expect(classifyMcpFailure(outer).kind).toBe("auth_expired");
  });

  test("非 Error 入参(字符串/对象)兜底为字符串扫描", () => {
    expect(classifyMcpFailure("401 unauthorized").kind).toBe("auth_expired");
    expect(classifyMcpFailure({ weird: true }).kind).toBe("unknown");
  });
});

describe("mcpToolFailureError — 结构化诊断文本", () => {
  const server = { id: "s1", commonOptions: { name: "GitHub", enable: true } } as never;

  test("单行头含 kind/retryable/action,尾部 cause 保留原始细节", () => {
    const err = mcpToolFailureError(server, "mcp__search", new Error("HTTP 401 invalid_token"));
    expect(err.message).toStartWith("MCP_TOOL_FAILURE ");
    const [head, causeLine] = err.message.split("\n");
    expect(head).toContain('server="GitHub"');
    expect(head).toContain("kind=auth_expired");
    expect(head).toContain("retryable=false");
    expect(head).toContain("action=inform_user_reauthorize");
    expect(causeLine).toStartWith("cause=");
    expect(causeLine).toContain("401");
  });

  test("网络瞬态诊断标 retryable=true,模型据此前放心重试", () => {
    const err = mcpToolFailureError(server, "mcp__lookup", new Error("MCP request timed out after 30s"));
    expect(err.message).toContain("kind=network_transient");
    expect(err.message).toContain("retryable=true");
    expect(err.message).toContain("action=retry_with_backoff");
  });

  test("服务器对象缺失时退化用工具名标注,不抛错", () => {
    const err = mcpToolFailureError(null, "mcp__orphan", new Error("boom"));
    expect(err.message).toContain('server="mcp__orphan"');
  });

  test("cause 超长按 500 字符截断(防爆 token)", () => {
    const long = "x".repeat(2000);
    const err = mcpToolFailureError(server, "mcp__t", new Error(`HTTP 401 ${long}`));
    const cause = err.message.split("\n")[1] ?? "";
    expect(cause.length).toBeLessThan(520);
  });
});

describe("isServerInUse — 决策①的探活门槛", () => {
  const server = (id: string, enable = true) =>
    ({ id, commonOptions: { name: id, enable } }) as never;
  const assistantWith = (ids: string[]) => ({ mcpServers: ids });

  test("启用 + 被某助手选中 → 探活", () => {
    expect(isServerInUse(server("s1"), [assistantWith(["s1"])])).toBe(true);
  });

  test("禁用 → 不探活(即使被选中)", () => {
    expect(isServerInUse(server("s1", false), [assistantWith(["s1"])])).toBe(false);
  });

  test("启用但无任何助手选中 → 不探活(闲置永不标红)", () => {
    expect(isServerInUse(server("s1"), [assistantWith(["other"])])).toBe(false);
    expect(isServerInUse(server("s1"), [])).toBe(false);
  });
});

describe("McpHealthSupervisor — 状态机与主动重连", () => {
  const mkServer = (id: string) => ({ id, commonOptions: { name: id, enable: true } }) as never;
  const assistants = [{ mcpServers: ["s1"] }];
  /** 可控 probe 桩:按队列返回成功或抛错。 */
  const probeQueue = (outcomes: Array<"ok" | Error>) => {
    let i = 0;
    return async () => {
      const o = outcomes[Math.min(i++, outcomes.length - 1)];
      if (o instanceof Error) throw o;
      return { tools: [] };
    };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("探活成功 → ready,失败计数清零", async () => {
    const sup = new McpHealthSupervisor({
      getServers: () => [mkServer("s1")],
      getAssistants: () => assistants,
      probe: probeQueue(["ok"]),
    });
    sup.reconcile();
    await flush();
    expect(sup.snapshot()["s1"]).toEqual({ status: "ready" });
    sup.dispose();
  });

  test("授权过期(不可自救)→ 立即 failed,不进入重连退避", async () => {
    const sup = new McpHealthSupervisor({
      getServers: () => [mkServer("s1")],
      getAssistants: () => assistants,
      probe: probeQueue([new Error("HTTP 401 invalid_token")]),
    });
    sup.reconcile();
    await flush();
    const entry = sup.snapshot()["s1"];
    expect(entry.status).toBe("failed");
    if (entry.status === "failed") {
      expect(entry.kind).toBe("auth_expired");
      expect(entry.retryable).toBe(false);
      expect(entry.consecutiveFailures).toBe(1);
    }
    sup.dispose();
  });

  test("网络瞬态失败 → reconnecting(退避中),retryable=true", async () => {
    const sup = new McpHealthSupervisor({
      getServers: () => [mkServer("s1")],
      getAssistants: () => assistants,
      probe: probeQueue([new Error("connect ETIMEDOUT")]),
    });
    sup.reconcile();
    await flush();
    const entry = sup.snapshot()["s1"];
    expect(entry.status).toBe("reconnecting");
    sup.dispose();
  });

  test("闲置服务器(未选中)reconcile 后不进入状态面", async () => {
    const sup = new McpHealthSupervisor({
      getServers: () => [mkServer("s1")],
      getAssistants: () => [{ mcpServers: ["other"] }],
      probe: probeQueue(["ok"]),
    });
    sup.reconcile();
    await flush();
    expect(sup.snapshot()["s1"]).toBeUndefined();
    sup.dispose();
  });

  test("retryNow 清失败计数并立即重探,成功回到 ready", async () => {
    const probe = probeQueue([new Error("HTTP 401 invalid_token"), "ok"]);
    const sup = new McpHealthSupervisor({
      getServers: () => [mkServer("s1")],
      getAssistants: () => assistants,
      probe,
    });
    sup.reconcile();
    await flush();
    expect(sup.snapshot()["s1"].status).toBe("failed");
    sup.retryNow("s1");
    await flush();
    expect(sup.snapshot()["s1"]).toEqual({ status: "ready" });
    sup.dispose();
  });
});
