// pi-engine/resources.ts — pi 会话资源装配(P4,方案 §三/§4.2 的落点;P2 起输入是契约数据)
//
// 统一管理模型的执行层:每类资源只有一个"家",由应用侧组装成契约 EngineInstructions
// (engines/instructions.ts),pi 每次会话由此注满——
// - 技能:唯一技能库(instructions.skills.dir,additionalSkillPaths)+ noSkills:true 在路径层
//   封死 pi 默认目录(agentDir/skills 与 cwd/.pi/skills,"不搞项目级"落实在源头);
//   skillsOverride 再做启用名单白名单 + 滤 project 来源(防御纵深)。
// - 设置:SettingsManager.inMemory + projectTrusted:false——零文件 I/O,工作区里的
//   .pi/settings.json 与 .pi/SYSTEM.md(resource-loader.discoverSystemPromptFile 按
//   projectTrusted 门控)两个不可信注入面一并封死(P1 纪要遗留项)。
// - AGENTS.md(全局+项目两层,全部走 pi 原生上下文件通道):
//   全局层(引擎中立的家,内容由应用读好放在 instructions.globalAgentsFile)经
//   agentsFilesOverride 以 virtual file 注入(SDK 官方宿主姿势,examples/sdk/
//   07-context-files.ts 同款)——渲染进 pi 原生 <project_context>/<project_instructions>
//   管线,与项目层同格式;上游对上下文件的任何改进(渲染/去重/权重)自动继承。
//   项目层走 pi 原生 loadProjectContextFiles(cwd 祖先链),同一 override 里做
//   词法过滤(越出工作区边界的祖先滤掉,提示词层与工具层同一边界纪律)。
//   排序:全局件 unshift 在 override 输出首位 = pi 原生 agentDir 全局件的既有序。
// - 人设+记忆:appendSystemPrompt 单一插槽(§3.4,只放应用自己的域:人设/记忆/
//   搜索指引/教学行/注入面),内容由应用侧冻结(同会话逐字节稳定)。
// - 插件(P5.2):契约给的插件清单 → plugins/entries 展开成入口文件 → additionalExtensionPaths,
//   加载结果经 extensionsOverride 交裁决层(plugins/arbiter);noExtensions:true 不变(只加载清单里的,
//   不读 pi 设置里的包与默认扩展目录),内建扩展(mcp / llama / codemode / tool-search)只经
//   extensionFactories 进入,我们不传,恒不加载。清单为空时这两项都不传,加载器配置与此前逐项相同。
// - prompt 模板/主题:全关(noPromptTemplates/noThemes)。
//
// 上下文件、技能清单与插件集合在 ResourceLoader.reload 时点定格(每轮生成装配一次,用户编辑下轮
// 生效——与技能开关同语义)。

import { isAbsolute, resolve, sep } from "node:path";
import { DefaultResourceLoader } from "../../pi/packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../../pi/packages/coding-agent/src/core/settings-manager.ts";
import type { EngineErrorReport, EngineInstructions, EnginePlugin } from "../engines/contract";
import { piAgentDir } from "../foundation/paths";
import { PI_THINKING_BUDGETS } from "./model-bridge";
import { arbitratePiExtensions } from "./plugins/arbiter";
import { pluginIdForExtensionPath, resolvePiPluginEntries, type PiPluginEntry } from "./plugins/entries";

export interface PiSessionResources {
  resourceLoader: DefaultResourceLoader;
  settingsManager: SettingsManager;
  /** 本轮加载的插件入口(入口文件 → 插件 id);空 = 无插件,runner 不做插件绑定。 */
  plugins: PiPluginEntry[];
}

// ---- 边界过滤 ----

/** 词法子树判定(与 workspace/approval.isLexicallyOutsideRoot 同前缀语义,Windows
 *  大小写不敏感)。AGENTS.md 过滤不碰 realpath:提示词层不执行任何东西,词法足够。 */
function isWithinRoot(path: string, root: string): boolean {
  const cmp = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const target = cmp(resolve(path));
  const rootCmp = cmp(resolve(root));
  return target === rootCmp || target.startsWith(rootCmp.endsWith(sep) ? rootCmp : rootCmp + sep);
}

// ---- diagnostics 上报(按内容键控:同一告警重复 reload 只报一次,内容变了复报) ----

const reportedDiagnostics = new Set<string>();

/** 技能开关/库路径变更后调用,让同一告警在新配置下重新评估是否上报。 */
export function invalidateReportedSkillDiagnostics(): void {
  reportedDiagnostics.clear();
}

// ---- 装配入口 ----

/** 每轮生成装配一次(与 createAgentSession 一次一会话同频)。 */
export async function createPiSessionResources(options: {
  /** 会话工作目录(pi cwd,AGENTS.md 祖先链起点)。 */
  cwd: string;
  /** 工作区边界根(AGENTS.md 过滤基准)。 */
  root: string;
  instructions: EngineInstructions;
  /** 本轮插件清单(契约 TurnInput.plugins / CompactRequest.plugins);不传 = 无插件。 */
  plugins?: EnginePlugin[];
  /** 压缩保留窗口覆盖(pi chars/4 估算口径)。手动压缩装配点传
   *  MANUAL_COMPACT_KEEP_RECENT_TOKENS(门槛/保留都调低,rationale 见 runner.ts 常量);
   *  不传 = pi 默认 20000(生成会话的 threshold/overflow 自动压缩用)。 */
  compactionKeepRecentTokens?: number;
  /** 技能加载诊断的上报出口(生产 = host.report)。 */
  report?: (report: EngineErrorReport) => void;
}): Promise<PiSessionResources> {
  const { cwd, root, instructions, plugins = [], compactionKeepRecentTokens, report } = options;
  // inMemory:零文件 I/O(不读不写任何 settings.json);projectTrusted:false 是给
  // resource-loader 的发现逻辑看的(.pi/SYSTEM.md 门控)。压缩面 P5 接管:threshold/
  // overflow 自动压缩显式开启(数值与 pi 默认一致,但不再依赖库默认值漂移),
  // reserveTokens/keepRecentTokens 取 pi 默认;重试等其余会话行为仍取 pi 默认值。
  // thinkingBudgets:Google 2.x 预算通道与聊天引擎同数值(model-bridge 四键投影,方言单源)。
  // images.autoResize:false(D4 拍板):pi 1.0 起用户 prompt 图片默认缩放并追加说明文字,
  // 而我们的引擎上下文每轮由 context-encoder 从 SQLite 原图重建——本轮「缩放图+说明」
  // 下轮「原图无说明」,模型前后所见不一致且该轮缓存失效。关闭后两轮逐字节一致
  // (代价:工具结果图片也不缩放,与我们聊天引擎的图片直发口径对齐)。
  // cacheWarming:"streaming"(pi 1.5.1 起默认 idle,运行之间最长保温 30 分钟):显式钉回 1.0.3
  // 语义。runner 每轮结束即 dispose(会取消预热),idle 档在我们这里几乎不生效,不如说死;
  // 预热归属在方案 P2.3 的 ModelGrant 缓存策略里重定。
  // enableInstallTelemetry:false:SDK 路径下它只决定 pi 的归属头(client-identity.ts:关闭则
  // attribution 为 null,OpenRouter/NVIDIA/opencode 不再收到 pi 的归属头);pi 的版本 ping
  // 只在 CLI 交互模式跑,与我们无关。
  const settingsManager = SettingsManager.inMemory(
    {
      compaction: {
        enabled: true,
        ...(compactionKeepRecentTokens != null ? { keepRecentTokens: compactionKeepRecentTokens } : {}),
      },
      thinkingBudgets: { ...PI_THINKING_BUDGETS },
      images: { autoResize: false },
      cacheWarming: "streaming",
      enableInstallTelemetry: false,
    },
    { projectTrusted: false },
  );
  const enabledSkills = new Set(instructions.skills.enabled);
  const globalFile = instructions.globalAgentsFile;
  const pluginEntries = resolvePiPluginEntries(plugins);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: piAgentDir,
    settingsManager,
    noExtensions: true,
    ...(pluginEntries.entries.length > 0
      ? {
          additionalExtensionPaths: pluginEntries.entries.map((entry) => entry.file),
          extensionsOverride: arbitratePiExtensions,
        }
      : {}),
    noPromptTemplates: true,
    noThemes: true,
    noSkills: true,
    additionalSkillPaths: [instructions.skills.dir],
    skillsOverride: ({ skills, diagnostics }) => ({
      skills: skills.filter((skill) => skill.sourceInfo?.scope !== "project" && enabledSkills.has(skill.name)),
      diagnostics,
    }),
    agentsFilesOverride: ({ agentsFiles }) => {
      // 项目层:词法边界过滤(pi 默认 agentDir 全局件不在工作区内,天然被滤)。
      const project = agentsFiles.filter((file) => isAbsolute(file.path) && isWithinRoot(file.path, root));
      // 全局层:virtual file 注入首位(SDK 官方宿主姿势)——渲染走 pi 原生
      // <project_instructions> 管线,与项目层同格式。
      return { agentsFiles: globalFile ? [{ path: globalFile.path, content: globalFile.content }, ...project] : project };
    },
    appendSystemPrompt: instructions.appendSystemPrompt,
  });
  // sdk 只对自建 loader 调 reload(sdk.ts createAgentSession),外部传入的必须自己加载。
  await resourceLoader.reload();

  // 技能校验告警面向用户在设置页内联展示(api/handlers/skills 的独立校验);这里只把
  // pi 实际加载时的诊断落进错误中心(warn),让"技能没被加载"有迹可循。
  for (const diagnostic of resourceLoader.getSkills().diagnostics) {
    const key = `${diagnostic.path ?? ""}|${diagnostic.message}`;
    if (reportedDiagnostics.has(key)) continue;
    reportedDiagnostics.add(key);
    report?.({
      domain: "pi-engine",
      severity: "warn",
      message: `技能资源诊断:${diagnostic.message}${diagnostic.path ? `(${diagnostic.path})` : ""}`,
      code: "pi_skill_diagnostic",
      params: { path: diagnostic.path ?? "", message: diagnostic.message },
    });
  }

  // 插件加载失败(路径/入口问题 + pi 加载器报的模块错误、同名冲突)逐条进错误中心;其余插件照常加载。
  const pluginErrors = [
    ...pluginEntries.errors,
    ...resourceLoader.getExtensions().errors.map((item) => ({
      pluginId: pluginIdForExtensionPath(pluginEntries.entries, item.path) ?? "",
      path: item.path,
      error: item.error,
    })),
  ];
  for (const item of pluginErrors) {
    const key = `plugin|${item.pluginId}|${item.path}|${item.error}`;
    if (reportedDiagnostics.has(key)) continue;
    reportedDiagnostics.add(key);
    report?.({
      domain: "pi-engine",
      severity: "warn",
      message: `插件加载失败:${item.pluginId || item.path}:${item.error}`,
      code: "pi_plugin_load_failed",
      params: { plugin: item.pluginId || item.path, error: item.error },
    });
  }

  return { resourceLoader, settingsManager, plugins: pluginEntries.entries };
}
