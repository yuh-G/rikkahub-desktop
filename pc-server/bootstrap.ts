// bootstrap.ts — 显式启动编排(全面审查 0-3/8-4/1-8/R1-1)
// 此前整个启动序列 = "server.ts import 块的求值顺序 + 三处模块顶层副作用"
// (state-load 装载迁移、conversations 定时器、api/sse 接线),约束只靠 import 顺序
// 隐式保证,且任何脚本/测试 import 到 state-load 就会执行真实磁盘迁移。
// R1-1:本函数改为异步,由 server.ts 在 Bun.serve 绑端口、打出 RIKKAHUB_PORT 标记之后
// 调用——重数据老用户的一次性迁移可达分钟级,旧的"先迁移后绑端口"会撞上壳的就绪
// 超时被连坐击杀,形成每次启动都从头重来的死循环。迁移期间 fetch 入口按启动闸门
// (foundation/startup-gate)把 /api 挡成 503,前端渲染迁移进度页。
// 实例锁(1-5)也随之移交 server.ts:锁冲突必须抢在端口标记打出之前退出,否则壳已
// 拿到端口并导航,只会看到一扇死窗口。

import { applyEffectiveProxy, installProxyFetchInterceptor, primeSystemProxyCache } from "./foundation/net";
import { installLlmRequestLogInterceptor } from "./pi-engine/llm-request-log";
import { setStartupPhase } from "./foundation/startup-gate";
import { saveState, setState, state } from "./persistence/json-store";
import { loadState } from "./persistence/state-load";
import { getConversationsDb, initConversationsRuntime } from "./conversations";
import { repairForkNodeTheft } from "./conversations/fork-repair";
import { initSseWiring } from "./api/sse";
import { initMcpHealthBroadcast } from "./api/sse";
import { startMcpHealthSupervisor } from "./tools/mcp-health";

export async function bootstrap(): Promise<void> {
  // 1) 状态装载 + 一次性迁移链(SQLite 灌库、记忆拆分、附件去重、.tmp 清扫都在 loadState 内)。
  //    R1-1:灌库分批提交、去重逐文件让出事件循环,迁移期启动进度端点可被响应。
  setStartupPhase("load-state");
  setState(await loadState());
  state.launchCount += 1;

  // 2) 代理拦截器:必须在首次出站 fetch 之前安装,否则首个请求会触发 Bun 的 env 快照
  //    锁定,之后改代理不生效。就绪前 /api 全部 503,不会有业务出站请求先行。
  installProxyFetchInterceptor(() => state.settings.proxyConfig);
  // 2b) 工作区 LLM 日志壳(日志问题 1):包在代理拦截器外层(后安装者先执行),pi SDK 内部的
  //     LLM fetch 经 AsyncLocalStorage 上下文记入统一日志管线,与聊天引擎同一套 addLog。
  installLlmRequestLogInterceptor();
  // R1-7:系统代理探测(reg query/gsettings)已全异步化,拦截器 per-request 只读缓存。
  // 这里预热一次,保证首个业务出站请求就能拿到正确的系统代理(之后 TTL 过期走
  // "陈值即用 + 后台刷新",事件循环永不被 spawn 阻塞)。
  await primeSystemProxyCache();
  applyEffectiveProxy(state.settings.proxyConfig);

  // 3) 会话运行时:working set 判据接线 + 驻留清扫定时器。
  initConversationsRuntime();

  // 3b) 历史 fork 缺陷修复:被分支抢走节点行的会话在就绪前还原(客户端加载到空会话
  //     之前必须完成)。幂等且只读扫描为主,失败仅记录,不阻断启动。
  try {
    const db = getConversationsDb();
    if (db) {
      const outcome = repairForkNodeTheft(db);
      if (outcome.repaired > 0 || outcome.skipped > 0) {
        console.log(`[fork-repair] 完成:修复 ${outcome.repaired} 个会话,跳过 ${outcome.skipped} 个`);
      }
    }
  } catch (err) {
    console.error("[fork-repair] 修复失败(不影响启动):", err);
  }

  // 4) SSE 接线:working set 的"界面正开着"判据 + 错误中心 SSE 广播。
  initSseWiring();

  // 4b) MCP 健康 Supervisor(7.2):引擎无关的后台探活/主动重连层。注入 SSE 快照出口 +
  //     配置/助手读取器,启动即对当前在用服务器探活一轮。探活本身异步,不阻塞启动。
  const mcpSupervisor = startMcpHealthSupervisor({
    getServers: () => (state.settings.mcpServers as Array<Record<string, import("./foundation/types").JsonValue>>),
    getAssistants: () => state.settings.assistants,
  });
  initMcpHealthBroadcast(() => mcpSupervisor.snapshot());

  // 5) 1-8:启动规范化结果(normalizeState 的 backfill/迁移标记)与 launchCount 立即落盘。
  //    此前只活在内存,纯只读会话(启动→看历史→退出)每次启动重跑全部规范化,
  //    launchCount 在这类会话中永不落盘。
  setStartupPhase("finalize");
  saveState();
}
