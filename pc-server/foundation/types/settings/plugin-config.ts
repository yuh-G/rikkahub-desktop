/** 插件来源。spec 是安装器认得的写法:npm = 包规格(含 file: / 压缩包地址),git = git+https:// 等仓库地址,
 *  local = 插件在本机的绝对路径(原地使用,不复制)。registry = npm 来源来自非默认 registry 的市场源时记下的地址,
 *  重装与更新用同一个。 */
export interface EnginePluginSource {
  kind: "npm" | "git" | "local";
  spec: string;
  registry?: string;
}

/** 插件包 package.json 里给人看的几项(P6.2.1):安装 / 重装时读一次存进记录,首页的行与详情直接用。说明截到 500 字,
 *  其余截到 200;读不到的项不出现。单个文件的本地插件没有包,整项缺省。 */
export interface EnginePluginMeta {
  description?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
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
  meta?: EnginePluginMeta;
}

/** 用户添加的插件市场源(P6.2.2,方案 §5.13);内置的是代码里的常量表(engines/plugin-market)。桌面端独有:
 *  导出给 APP 时剥离,APP→桌面端导入保桌面端的值。npm-registry = 按引擎的包关键词检索的 registry;catalog = 一份
 *  插件清单 JSON。 */
export interface PluginMarketSourceRecord {
  id: string;
  engine: string;
  kind: "npm-registry" | "catalog";
  name: string;
  url: string;
  addedAt: string;
}

export interface PluginConfig {
  enginePlugins: EnginePluginRecord[];
  pluginMarketSources: PluginMarketSourceRecord[];
}
