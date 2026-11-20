// conversations/engine-host-route.test.ts — 工作区会话经监管器跑时,宿主进程的故障在会话上怎么收尾(P7.2.6)
//
// 注册表的 pi 驱动换成「真监管器 + 测试替身宿主」(不起子进程):
//   1) 宿主进程中途没了:本条回答按「出错」收尾(错误卡写监管器的原文、计入失败、队列暂停),不按中止;
//      监管器的提示走错误中心(带码),不再按供应商错误重复上报;
//   2) 宿主进程无响应:有调用卡在它上面的会话亮「引擎无响应」状态条,SSE 重连时补发;缓过来后撤掉。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-engine-host-route-"));

const conversations = await import("./index");
const { configureWorkingSet, registerConversation } = await import("./working-set");
const { getConversationMeta } = await import("./read-queries");
const { engineUnresponsive, generating } = await import("./generation-state");
const { generateAnswer } = await import("./orchestrator");
const ws = await import("../workspace");
const { defaultAssistant } = await import("../assistants");
const { defaultState } = await import("../app-config/defaults");
const { setState, state } = await import("../persistence/json-store");
const { model, provider } = await import("../model-providers");
const { handleConversationRoutes } = await import("../api/handlers/conversations");
const { clearAppErrors, recentAppErrors } = await import("../observability/app-errors");
const { notifyEngineHostState, replaceEngineDriverForTests, reportEngineHostTrouble } = await import("../engines/index");
const { EngineHostSupervisor, supervisedDriver } = await import("../subprocess-engine/supervisor");
const { PI_CAPABILITIES } = await import("../pi-engine/capabilities");
const { EngineChannelClosedError } = await import("../engines/rpc-transport");

import type { EngineDriver } from "../engines/contract";
import type { Conversation, State } from "../foundation/types";
import type { SupervisedHost, SupervisorEvent } from "../subprocess-engine/supervisor";

const priorState = state;
const db = conversations.openConversationsDb();
configureWorkingSet({
  loadConversation: (convId) => {
    const meta = getConversationMeta(db, convId);
    if (!meta) return undefined;
    meta.messages = conversations.loadConversationNodesFromDb(db, convId);
    return meta;
  },
  isGenerating: (id) => generating.has(id),
  hasSseClients: () => false,
  hasDirty: () => false,
});

/** 替身宿主:startTurn 按 behavior 走;exit() 模拟进程没了(在途调用以通道关闭拒绝)。 */
class StubHost implements SupervisedHost {
  static nextPid = 5000;
  readonly pid = StubHost.nextPid++;
  private finish!: (info: Awaited<SupervisedHost["exited"]>) => void;
  readonly exited = new Promise<Awaited<SupervisedHost["exited"]>>((done) => (this.finish = done));
  private readonly inflight = new Set<(err: unknown) => void>();
  readonly driver: EngineDriver;
  started = 0;
  answerPing: (() => void) | null = null;
  silent = false;

  constructor(behavior: "crash" | "stall") {
    this.driver = {
      kind: "pi",
      capabilities: PI_CAPABILITIES,
      startTurn: () => {
        this.started += 1;
        return new Promise((resolve, reject) => {
          this.inflight.add(reject);
          if (behavior === "crash") queueMicrotask(() => this.exit({ exitCode: 3, stderrTail: "插件把进程带走了" }));
          else this.answerTurn = () => resolve({ text: "缓过来了", stopReason: "stop", compactions: [] });
        });
      },
      abort: async () => undefined,
      invalidate: async () => undefined,
      dispose: async () => undefined,
    };
  }

  answerTurn: (() => void) | null = null;

  ping = () => (this.silent ? new Promise<unknown>((done) => (this.answerPing = () => done(true))) : Promise.resolve(true));

  exit(info: Partial<Awaited<SupervisedHost["exited"]>> = {}): void {
    for (const reject of this.inflight) reject(new EngineChannelClosedError("通道已关闭"));
    this.inflight.clear();
    this.finish({ exitCode: 0, signal: null, stderrTail: "", ...info });
  }

  kill = () => this.exit({ exitCode: null, signal: "SIGKILL" });
  stop = async () => this.exit();
}

const hosts: StubHost[] = [];
let behavior: "crash" | "stall" = "crash";
const supervisor = new EngineHostSupervisor<StubHost>({
  name: "pi",
  launch: async () => {
    const host = new StubHost(behavior);
    hosts.push(host);
    return host;
  },
  onEvent: (event: SupervisorEvent) => {
    if (event.kind === "state") notifyEngineHostState(event.state, supervisor.activeConversations());
    else reportEngineHostTrouble(event);
  },
  timing: { pingIntervalMs: 10, unresponsiveAfterMs: 40, restartAfterMs: 60_000, lagToleranceMs: 1_000, idleReclaimMs: 60_000 },
});
const restoreDriver = replaceEngineDriverForTests(supervisedDriver(supervisor, "pi", PI_CAPABILITIES));
afterAll(async () => {
  restoreDriver();
  await supervisor.dispose();
  setState(priorState);
});

function installState() {
  const ourModel = model("fake-model", "Host Route Model");
  const ourProvider = provider({ id: crypto.randomUUID(), name: "Host Route Provider", baseUrl: "http://127.0.0.1:9", apiKey: "sk-test", enabled: true, models: [ourModel] });
  const next = defaultState();
  next.settings.assistantId = "a1";
  next.settings.assistants = [{ ...defaultAssistant(), id: "a1", name: "host-route" }];
  next.settings.providers = [ourProvider];
  next.settings.chatModelId = ourModel.id;
  next.settings.fastModelId = "";
  setState(next as State);
}

let seq = 0;
function seedWorkspaceConversation(): Conversation {
  seq += 1;
  const now = Date.now();
  const workspace = ws.createWorkspace({ type: "managed", name: `host-route-${seq}` });
  const conversation = {
    id: `host-route-conv-${seq}`,
    assistantId: "a1",
    systemPrompt: null,
    title: `已命名会话 ${seq}`,
    messages: [{
      id: `host-route-n-${seq}`,
      selectIndex: 0,
      messages: [{ id: `host-route-m-${seq}`, role: "USER", parts: [{ type: "text", text: "请干活" }], annotations: [], createdAt: new Date(now).toISOString(), finishedAt: null, translation: null }],
    }],
    chatSuggestions: [],
    isPinned: false,
    createAt: now,
    updateAt: now,
    workspaceId: workspace.id,
  } as unknown as Conversation;
  conversations.persistConversation(conversation);
  registerConversation(conversation);
  return conversation;
}

function lastAssistantMessage(conversation: Conversation) {
  const node = conversation.messages[conversation.messages.length - 1]!;
  return node.messages[node.selectIndex] ?? node.messages[0]!;
}

async function until(check: () => boolean, ms = 3_000) {
  const startedAt = performance.now();
  while (!check() && performance.now() - startedAt < ms) await Bun.sleep(5);
  return check();
}

async function readStreamSnapshot(conversationId: string): Promise<string> {
  const url = new URL(`http://localhost/api/conversations/${conversationId}/stream`);
  const response = await handleConversationRoutes(new Request(url), url, `conversations/${conversationId}/stream`);
  const reader = response!.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  for (let i = 0; i < 3 && !received.includes("event: engine-status"); i++) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return received;
}

describe("工作区会话经引擎宿主进程(P7.2.6)", () => {
  test("宿主进程中途没了:按出错收尾(错误卡写原文、队列暂停),提示走错误中心且只有一条", async () => {
    installState();
    clearAppErrors();
    behavior = "crash";
    const conversation = seedWorkspaceConversation();
    await generateAnswer(conversation);
    const answer = lastAssistantMessage(conversation);
    expect(answer.role).toBe("ASSISTANT");
    expect(answer.finishedAt).not.toBeNull();
    const failure = (answer.annotations as Array<{ type?: string; message?: string }>).find((item) => item.type === "model_call_error");
    expect(failure?.message).toContain("pi 引擎进程意外退出");
    expect(failure?.message).toContain("插件把进程带走了");
    expect(generating.has(conversation.id)).toBe(false);
    expect(await until(() => recentAppErrors().some((entry) => entry.code === "engine_host_crashed"))).toBe(true);
    expect(recentAppErrors().filter((entry) => entry.domain === "provider")).toEqual([]);
  }, 15_000);

  test("宿主进程无响应:卡住的会话亮状态条,重连时补发;缓过来后撤掉", async () => {
    installState();
    behavior = "stall";
    const conversation = seedWorkspaceConversation();
    // 先让上一条用例重启出来的进程退场,本条用自己的替身
    await supervisor.stop();
    const run = generateAnswer(conversation);
    expect(await until(() => hosts.at(-1)?.started === 1)).toBe(true);
    const host = hosts.at(-1)!;
    host.silent = true;
    expect(await until(() => engineUnresponsive.has(conversation.id))).toBe(true);
    const snapshot = await readStreamSnapshot(conversation.id);
    expect(snapshot).toContain('"phase":"unresponsive"');
    host.silent = false;
    host.answerPing?.();
    expect(await until(() => !engineUnresponsive.has(conversation.id))).toBe(true);
    host.answerTurn?.();
    await run;
    expect(lastAssistantMessage(conversation).finishedAt).not.toBeNull();
  }, 15_000);
});
