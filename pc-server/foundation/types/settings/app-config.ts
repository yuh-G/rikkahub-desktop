import type { JsonValue } from "..";

export interface AppConfig {
  dynamicColor: boolean;
  themeId: string;
  developerMode: boolean;
  displaySetting: Record<string, JsonValue>;
  preferredPort: number | null;
  /** PC-only:用户上一次选择的工作区权限档位(新建工作区的默认档位记忆);
   *  null = 从未选择过,新建取 balanced(默认权限)。 */
  workspaceLastPermissionPreset: string | null;
  keybindings: Record<string, JsonValue>;
  webServerJwtEnabled: boolean;
  /** PC-only:设置页内置访问密码的 HMAC 派生哈希(P1)。undefined/空 = 未设。
   *  永不存明文、不下发前端(仅经 webPasswordConfigured 布尔暴露);备份导出 to-android 剥离
   *  (对齐 shellPath 同款,敏感+PC-only),pc-backup 保留以便 PC→PC 跨机恢复带上。 */
  webPasswordHash?: string;
  /** PC-only:自定义 bash 可执行文件路径(如 C:\cygwin64\bin\bash.exe)。
   *  空串 = 未指定,getShellConfig 走自动探测(系统 Git Bash → 内嵌兜底)。
   *  机器级绝对路径,导出备份时剥离(PC→APP/跨机无意义,见 backup/export.ts stripPcOnly)。 */
  shellPath?: string;
  /** PC-only:最近一次云端(WebDAV/S3)恢复的结构化降级报告(B2)。流式恢复路径无导入
   *  汇总卡,把跳过/降级计数暂存于此,经设置 SSE 推到前端数据页展示。仅记录、不参与导出。 */
  lastRestoreReport?: {
    finishedAt: string;
    source: string;
    filesDeduped: number;
    dbReadError: string | null;
    messageNodesUnreadable: number;
  } | null;
}
