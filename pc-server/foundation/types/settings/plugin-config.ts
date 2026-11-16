/** 插件来源。spec 是安装器认得的写法:npm = 包规格(含 file: / 压缩包地址),git = git+https:// 等仓库地址,
 *  local = 插件在本机的绝对路径(原地使用,不复制)。 */
export interface EnginePluginSource {
  kind: "npm" | "git" | "local";
  spec: string;
}

/** 插件记录(方案 §5.9,P5.8)。PC-only:导出给 APP 时剥离,APP→桌面端导入保桌面端的值;安装目录
 *  (<数据目录>/engines/<engine>/npm)不进任何备份,换机恢复后记录在、包不在,按「未安装」显示,重装即可。 */
export interface EnginePluginRecord {
  /** `<engine>:<name>`,重名追加 `#2`…;审计、否决署名、审批来源、助手绑定都用它。 */
  id: string;
  engine: string;
  /** 包名(npm / git 安装时决定安装位置);local = 显示名(package.json 的 name,否则目录名或文件名)。 */
  name: string;
  source: EnginePluginSource;
  version: string | null;
  /** 全局启停;会话加载 = 全局已启用 ∩ 会话助手已绑定。 */
  enabled: boolean;
  /** 行为裁决的兜底开关(D7):false = 停用这个插件的 tool_call 钩子。 */
  hookSwitches: { toolCall: boolean };
  /** 逐工具设置(按插件登记的工具名):enabled=false 不进会话;exempt=true 免审批。缺省 = 启用、询问。 */
  toolSwitches: Record<string, { enabled?: boolean; exempt?: boolean }>;
  installedAt: string;
}

export interface PluginConfig {
  enginePlugins: EnginePluginRecord[];
}
