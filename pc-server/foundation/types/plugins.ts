// foundation/types/plugins.ts — 插件管理接口(api/handlers/plugins.ts)的跨端契约(P6.1)
//
// 叶子模块:只放前端可见的 DTO 形状,web-ui 经 @server 别名 type-only 引用(纪律同 commands.ts)。

import type { EnginePluginRecord } from "./settings";

/** 插件列表的一行:记录 + 包的位置 + 包在不在(换机恢复后记录在、包不在,按「未安装」显示)。 */
export type EnginePluginViewDto = EnginePluginRecord & { path: string; installed: boolean };

/** GET plugins */
export interface EnginePluginListDto {
  plugins: EnginePluginViewDto[];
}

/** 安装 / 重装 / 启停 / 开关的返回:改完的那一行。 */
export interface EnginePluginMutationDto {
  plugin: EnginePluginViewDto;
}

/** 插件哪部分没生效、为什么(engines/plugin-audit):同一码同一对象只留一条,次数累加。 */
export interface PluginAuditEntryDto {
  code: string;
  /** tool:<名>、command:<名>、event:<名>…;加载失败为 load;否决与作废是工具名。 */
  subject: string;
  detail?: string;
  count: number;
  lastAt: string;
}

/** 插件登记了什么(加载一次插件代码读出)。 */
export interface EnginePluginInspectionDto {
  tools: Array<{ name: string; description?: string }>;
  /** 入口类同名的指令不列(裁决层恒拿掉)。 */
  commands: Array<{ name: string; description?: string }>;
  /** 加载期经 registerMcpServer 声明的 MCP 服务(应用登记进自己的 MCP 列表)。 */
  mcpServers: Array<{ name: string; config: Record<string, unknown> }>;
  errors: string[];
}

/** GET plugins/detail */
export interface EnginePluginDetailDto extends EnginePluginInspectionDto {
  plugin: EnginePluginViewDto;
  audit: PluginAuditEntryDto[];
}

/** GET plugins/audit */
export interface EnginePluginAuditDto {
  audit: PluginAuditEntryDto[];
}
