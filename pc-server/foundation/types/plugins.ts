// foundation/types/plugins.ts — 插件管理接口(api/handlers/plugins.ts)的跨端契约(P6.1)
//
// 叶子模块:只放前端可见的 DTO 形状,web-ui 经 @server 别名 type-only 引用(纪律同 commands.ts)。

import type { EnginePluginRecord, EnginePluginSource, PluginMarketSourceRecord } from "./settings";

/** 有插件运行时的引擎(engines/plugin-engines.ts 的表;插件页按它的顺序分组,前端不写死)。 */
export interface PluginEngineDto {
  id: string;
  label: string;
}

/** 插件列表的一行:记录 + 包的位置 + 包在不在(换机恢复后记录在、包不在,按「未安装」显示)+ 运行记录的摘要
 *  (loadFailed = 最近一次加载失败过;auditCount = 运行记录的条数)。 */
export type EnginePluginViewDto = EnginePluginRecord & { path: string; installed: boolean; loadFailed: boolean; auditCount: number };

/** GET plugins */
export interface EnginePluginListDto {
  engines: PluginEngineDto[];
  plugins: EnginePluginViewDto[];
}

/** GET plugins/updates:只含能检查更新的记录(npm 来源且没钉版本)。latest = null 表示没查到。 */
export interface EnginePluginUpdatesDto {
  updates: Record<string, { latest: string | null; hasUpdate: boolean }>;
  checkedAt: string;
}

/** 安装 / 重装 / 启停 / 开关的返回:改完的那一行。 */
export interface EnginePluginMutationDto {
  plugin: EnginePluginViewDto;
}

/** POST plugins/upload 的 409:包名(单个脚本是文件名)与已装的一条相同。界面问过后带 replace=1 重发即替换它,
 *  替换沿用它的 id、启停、开关与各处的选择。 */
export interface EnginePluginUploadConflictDto {
  error: string;
  code: 409;
  errorCode: "plugin_name_conflict";
  existing: EnginePluginViewDto;
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
  /** 包根的 README(截到 200 KB);没有包或没有说明时为 null。 */
  readme: string | null;
}

/** GET plugins/audit */
export interface EnginePluginAuditDto {
  audit: PluginAuditEntryDto[];
}

/** 市场源(内置 + 用户添加)。 */
export type PluginMarketSourceDto = Omit<PluginMarketSourceRecord, "addedAt"> & { builtin: boolean; addedAt?: string };

/** GET plugins/market/sources */
export interface PluginMarketSourcesDto {
  sources: PluginMarketSourceDto[];
}

/** 市场里的一个包。source = 从市场安装时交给 POST plugins/install 的来源;installed = 按引擎 + 包名对上的已装记录。 */
export interface PluginMarketItemDto {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  monthlyDownloads?: number;
  updatedAt?: string;
  links: { npm?: string; homepage?: string; repository?: string };
  source: EnginePluginSource;
  installed?: { pluginId: string; version: string | null; hasUpdate: boolean };
}

/** GET plugins/market?source=&q=&page=[&refresh=1](page 从 0 起)。staleError = 市场源这次没连上,给的是过期的缓存。 */
export interface PluginMarketPageDto {
  items: PluginMarketItemDto[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  fromCache: boolean;
  generatedAt: string;
  staleError?: string;
}

/** GET plugins/market/detail?source=&name=。resources = 包声明的资源类型(没声明时缺省,界面写「安装时校验」)。 */
export interface PluginMarketDetailDto {
  item: PluginMarketItemDto;
  readme?: string;
  license?: string;
  resources?: { extensions: boolean; skills: boolean; prompts: boolean; themes: boolean };
}
