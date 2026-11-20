// engines/rpc-transport.test.ts — 跨进程传输的契约行为(P2.6;真子进程的证明在 smoke:engine-contract)
//
// 两个 peer 在内存里对接(每条消息异步投递,模拟管道),锁:握手带能力声明;同方向帧按序(事件先于
// startTurn 结果到达);拒绝原因跨通道保真(AbortError / CodedError);载荷不可序列化即在发出端
// 失败;通道关闭时在途调用以错误拒绝;未实现的方法回 METHOD_NOT_FOUND 而不是挂住。
import { describe, expect, test } from "bun:test";

import { CodedError } from "../foundation/errors";
import type { EngineDriver, EngineHost, TurnRef } from "./contract";
import { ContractPayloadError } from "./loopback";
import { connectDriverOverRpc, serveDriverOverRpc } from "./rpc-transport";

const turn: TurnRef = { conversationId: "conv-rpc", turnId: "turn-rpc" };

function wire(createDriver: (host: EngineHost) => EngineDriver, host: Partial<EngineHost> = {}) {
  const order: string[] = [];
  const protocolErrors: string[] = [];
  const fullHost: EngineHost = {
    emit: (_turn, event) => void order.push(`emit:${event.kind}`),
    session: { load: async () => ({ items: [], compactions: [] }), append: async () => undefined },
    tools: { call: async () => ({ content: [] }) },
    permission: { check: async () => ({ scope: "default" }) },
    interaction: { dialog: async () => ({ cancelled: true }), dismiss: () => undefined, show: () => undefined },
    steer: { take: async () => [] },
    turn: { request: () => undefined },
    models: { credential: async () => ({}), log: () => undefined },
    report: () => undefined,
    ...host,
  };
  const bytes = { toEngine: 0, toApp: 0 };
  let toEngine: (line: string) => void = () => {};
  const app = connectDriverOverRpc(
    (line) => {
      bytes.toEngine += line.length;
      queueMicrotask(() => toEngine(line));
    },
    fullHost,
    (reason) => void protocolErrors.push(reason),
  );
  const engine = serveDriverOverRpc(
    (line) => {
      bytes.toApp += line.length;
      queueMicrotask(() => app.receive(line));
    },
    createDriver,
    (reason) => void protocolErrors.push(reason),
  );
  toEngine = (line) => engine.receive(line);
  return { app, engine, order, protocolErrors, bytes };
}

function baseDriver(host: EngineHost, overrides: Partial<EngineDriver> = {}): EngineDriver {
  return {
    kind: "fake",
    capabilities: { resumeSemantics: "run-and-suspend", steering: "boundary", nativeCompaction: false, workspace: "none", placement: "portable", commands: false },
    startTurn: async () => ({ text: "", stopReason: null, compactions: [] }),
    abort: async () => {},
    invalidate: async () => {},
    dispose: async () => {},
    ...overrides,
  };
}

describe("跨进程传输", () => {
  test("握手带能力声明;事件(通知)先于 startTurn 的结果到达;宿主回调往返", async () => {
    const { app, order } = wire(
      (host) =>
        baseDriver(host, {
          async startTurn(req) {
            host.emit(req, { kind: "text_delta", text: "一" });
            const steer = await host.steer.take(req);
            host.emit(req, { kind: "text_delta", text: steer.join("") });
            return { text: `完成:${steer.join("")}`, stopReason: "stop", compactions: [] };
          },
        }),
      { steer: { take: async () => ["补发"] } },
    );
    const driver = await app.ready;
    expect(driver.kind).toBe("fake");
    expect(driver.capabilities.placement).toBe("portable");
    expect(driver.compact).toBeUndefined();
    const result = await driver.startTurn(turn);
    order.push("result");
    expect(result.text).toBe("完成:补发");
    expect(order).toEqual(["emit:text_delta", "emit:text_delta", "result"]);
  });

  test("拒绝原因保真:AbortError 还原为 DOMException,CodedError 带 errorCode", async () => {
    let mode: "abort" | "coded" = "abort";
    const { app } = wire((host) =>
      baseDriver(host, {
        async startTurn() {
          if (mode === "abort") throw new DOMException("Generation stopped", "AbortError");
          throw new CodedError("上下文过短", "compact_context_too_short");
        },
      }),
    );
    const driver = await app.ready;
    const aborted = await driver.startTurn(turn).catch((err) => err);
    expect(aborted).toBeInstanceOf(DOMException);
    expect(aborted.name).toBe("AbortError");
    mode = "coded";
    const coded = await driver.startTurn(turn).catch((err) => err);
    expect(coded).toBeInstanceOf(CodedError);
    expect(coded.errorCode).toBe("compact_context_too_short");
  });

  test("指令(P5.7):声明 commands 才有 listCommands / runCommand 代理,调用跨通道往返", async () => {
    const plain = await wire((host) => baseDriver(host)).app.ready;
    expect(plain.listCommands).toBeUndefined();
    expect(plain.runCommand).toBeUndefined();
    const { app } = wire((host) =>
      baseDriver(host, {
        capabilities: { ...baseDriver(host).capabilities, commands: true },
        listCommands: async (req) => [{ id: "c1", name: "todos", source: "plugin:dev:todo", description: req.conversationId }],
        runCommand: async (req) => ({ compactions: [{ cutMessageId: null, summary: `ran ${req.commandId} ${req.args}`, tokensBefore: 1 }] }),
      }),
    );
    const driver = await app.ready;
    expect(await driver.listCommands!({ conversationId: "conv-rpc", plugins: [], workspace: null })).toEqual([
      { id: "c1", name: "todos", source: "plugin:dev:todo", description: "conv-rpc" },
    ]);
    const input = { model: {} as never, reasoningLevel: null, workspace: null, instructions: { appendSystemPrompt: [], globalAgentsFile: null, skills: { dir: "", enabled: [] } }, plugins: [], prompt: { text: "", images: [] }, tools: [] };
    expect((await driver.runCommand!({ ...turn, input, commandId: "c1", args: "x" })).compactions[0]!.summary).toBe("ran c1 x");
  });

  test("会话视图按指纹对账:第二轮只传变了的条目;拼回的视图与整份相同;invalidate 后整份重传", async () => {
    const item = (id: string, text: string) => ({ message: { id, role: "USER", parts: [{ type: "text", text }] } as never, synthetic: false });
    let view = { items: [item("m1", "甲".repeat(5000)), item("m2", "乙".repeat(5000))], compactions: [] };
    const loaded: unknown[] = [];
    const { app, bytes } = wire(
      (host) =>
        baseDriver(host, {
          async startTurn(req) {
            const got = await host.session.load(req);
            loaded.push(structuredClone(got));
            // 驱动改了拿到的对象,不影响下一轮拼回的视图。
            (got.items[0]!.message as { id: string }).id = "被改了";
            return { text: "", stopReason: null, compactions: [] };
          },
        }),
      { session: { load: async () => structuredClone(view), append: async () => undefined } },
    );
    const driver = await app.ready;
    const roundBytes = async () => {
      const before = bytes.toEngine;
      await driver.startTurn(turn);
      return bytes.toEngine - before;
    };
    const first = await roundBytes();
    expect(first).toBeGreaterThan(10_000);
    view = { items: [...view.items, item("m3", "丙")], compactions: [] };
    const second = await roundBytes();
    expect(second).toBeLessThan(1_000);
    view = { items: [item("m1", "改过的第一条"), view.items[1]!, view.items[2]!], compactions: [] };
    expect(await roundBytes()).toBeLessThan(1_000);
    expect(loaded.at(-1)).toEqual({ items: [item("m1", "改过的第一条"), item("m2", "乙".repeat(5000)), item("m3", "丙")], compactions: [] });
    await driver.invalidate("conv-rpc");
    expect(await roundBytes()).toBeGreaterThan(5_000);
    expect(loaded.at(-1)).toEqual(view);
  });

  test("不可序列化的载荷在发出端失败(不让 JSON 静默丢字段)", async () => {
    const { app } = wire((host) => baseDriver(host));
    const driver = await app.ready;
    await expect(driver.startTurn({ ...turn, sneaky: () => 1 } as never)).rejects.toBeInstanceOf(ContractPayloadError);
  });

  test("引擎侧回调宿主时宿主抛错:错误回到引擎侧的 await 点", async () => {
    const { app } = wire(
      (host) =>
        baseDriver(host, {
          async startTurn(req) {
            try {
              await host.tools.call({ ...req, toolCallId: "t", name: "x", args: {} });
              return { text: "不应到达", stopReason: null, compactions: [] };
            } catch (err) {
              return { text: `工具失败:${(err as Error).message}`, stopReason: null, compactions: [] };
            }
          },
        }),
      {
        tools: {
          call: async () => {
            throw new Error("用户拒绝");
          },
        },
      },
    );
    const driver = await app.ready;
    expect((await driver.startTurn(turn)).text).toBe("工具失败:用户拒绝");
  });

  test("插件工具审批跨通道:请求原样到达宿主,宿主的拒绝回到引擎侧", async () => {
    const seen: unknown[] = [];
    const check = { ...turn, toolCallId: "tc-p", toolName: "counter_add", origin: { kind: "plugin" as const, pluginId: "dev:counter" } };
    const { app } = wire(
      (host) =>
        baseDriver(host, {
          async startTurn() {
            const outcome = await host.permission.check(check).then(
              () => "放行",
              (err: Error) => err.message,
            );
            return { text: outcome, stopReason: null, compactions: [] };
          },
        }),
      {
        permission: {
          check: async (req) => {
            seen.push(req);
            throw new Error("Tool execution denied by user. Reason: 不要");
          },
        },
      },
    );
    const driver = await app.ready;
    expect((await driver.startTurn(turn)).text).toBe("Tool execution denied by user. Reason: 不要");
    expect(seen).toEqual([check]);
  });

  test("插件界面跨通道:对话框请求-应答原样往返;dismiss / show 是单向通知", async () => {
    const seen: unknown[] = [];
    const dialog = { ...turn, requestId: "rq-1", source: "dev:asker", request: { kind: "select" as const, title: "选", options: ["a", "b"] } };
    const notice = { ...turn, source: "dev:asker", notice: { kind: "status" as const, key: "k", text: "状态" } };
    const { app } = wire(
      (host) =>
        baseDriver(host, {
          async startTurn() {
            host.interaction.show(notice);
            const answer = await host.interaction.dialog(dialog);
            host.interaction.dismiss({ ...turn, requestId: "rq-1" });
            return { text: JSON.stringify(answer), stopReason: null, compactions: [] };
          },
        }),
      {
        interaction: {
          dialog: async (call) => {
            seen.push(["dialog", call]);
            return { cancelled: false, value: "b" };
          },
          dismiss: (call) => void seen.push(["dismiss", call]),
          show: (call) => void seen.push(["show", call]),
        },
      },
    );
    const driver = await app.ready;
    expect(JSON.parse((await driver.startTurn(turn)).text)).toEqual({ cancelled: false, value: "b" });
    await Bun.sleep(5);
    expect(seen).toEqual([["show", notice], ["dialog", dialog], ["dismiss", { ...turn, requestId: "rq-1" }]]);
  });

  test("通道关闭:在途调用以错误拒绝,之后的调用立即拒绝", async () => {
    const { app } = wire((host) => baseDriver(host, { startTurn: () => new Promise(() => {}) }));
    const driver = await app.ready;
    const inflight = driver.startTurn(turn);
    await Bun.sleep(5);
    app.close("子进程退出");
    await expect(inflight).rejects.toThrow("引擎通道已关闭");
    await expect(driver.startTurn(turn)).rejects.toThrow("引擎通道已关闭");
  });

  test("驱动没有 compact:应用侧代理不暴露;硬调对端回错误而不是挂住", async () => {
    const { app, engine } = wire((host) => baseDriver(host));
    const driver = await app.ready;
    expect(driver.compact).toBeUndefined();
    const replies: string[] = [];
    // 直接向引擎侧投递一帧未声明能力的调用,观察它的回包。
    const probe = serveDriverOverRpc((line) => void replies.push(line), (host) => baseDriver(host), () => {});
    probe.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "driver.compact", params: [{}] }));
    probe.receive(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "driver.nope", params: [] }));
    await Bun.sleep(5);
    const responses = replies.map((line) => JSON.parse(line)).filter((frame) => frame.id !== undefined);
    expect(responses.find((frame) => frame.id === 1)?.error?.message).toContain("未实现原生压缩");
    expect(responses.find((frame) => frame.id === 2)?.error?.code).toBe(-32601);
    engine.close("测试结束");
  });

  test("进程运维消息(runtime.*)两个方向都能送达;名字不以 runtime. 开头即拒绝登记", async () => {
    const toEngine: unknown[][] = [];
    const toApp: unknown[][] = [];
    let deliverToEngine: (line: string) => void = () => {};
    const app = connectDriverOverRpc((line) => queueMicrotask(() => deliverToEngine(line)), {} as EngineHost, () => {}, {
      "runtime.appError": (...args: unknown[]) => void toApp.push(args),
    });
    const engine = serveDriverOverRpc((line) => queueMicrotask(() => app.receive(line)), (host) => baseDriver(host), () => {}, {
      "runtime.proxyConfig": (...args: unknown[]) => void toEngine.push(args),
      "runtime.ping": () => "pong",
    });
    deliverToEngine = (line) => engine.receive(line);
    await app.ready;
    app.notify("runtime.proxyConfig", [{ mode: "direct" }]);
    engine.notify("runtime.appError", [{ message: "x" }]);
    expect(await app.request("runtime.ping", [])).toBe("pong");
    await expect(app.request("driver.dispose", [])).rejects.toThrow("runtime.");
    await Bun.sleep(5);
    expect(toEngine).toEqual([[{ mode: "direct" }]]);
    expect(toApp).toEqual([[{ message: "x" }]]);
    expect(() => serveDriverOverRpc(() => {}, (host) => baseDriver(host), () => {}, { "driver.startTurn": () => undefined })).toThrow("runtime.");
  });
});
