// 设置页搜索的索引与打分。纯数据 + 纯函数,不 import 组件/React 运行时(与 settings-nav 同款),
// 测试可直接注入 t 跑打分。
//
// 粒度 = 全覆盖:每个页面一条(由 SETTINGS_NAV 推导,加页自动进索引)+ 每一个静态设置行
// (SettingsRow / SettingsSwitchRow / SettingsField / SettingsGroup 的标题,以及表驱动渲染的
// 开关、快捷键动作、场景模型、按钮式设置项)。tests/settings-search-index.test.ts 扫描设置组件
// 源码,新增设置行忘了登记即红(纯说明 / 列表子实体字段在测试的 NOT_SEARCHABLE 里逐条说明)。
// 不进索引:用户自己的数据(供应商 / 助手 / 服务名称等)、按服务类型由目录动态生成的字段
// (语音服务的配置项)。
//
// 定位:选中后壳层跳页,再在页面里按标题文字找到对应行滚动 + 闪烁(settings-search.tsx)。
// 标题与页面同源复用同一个 i18n key,所以改文案不会让定位漂移。用户搜了就是带着目的来的:
// 条目在页内分段标签(tabKey)下则先切过去,在「高级设置」折叠区里(advanced)则替他展开。
// 列表/详情页(供应商 / 助手…)的行作用于当前选中项的详情,不负责切换选中项。
import { SETTINGS_NAV, settingsSubItems, type SettingsPageKey, type SettingsTabId } from "./settings-nav";

export interface SettingsSearchEntry {
  readonly section: SettingsTabId;
  /** 有二级的一级必填,且必须属于该一级(测试锁)。 */
  readonly sub?: string;
  /** 标题的 i18n key(复用页面里同一个 key)。与 label 二选一。 */
  readonly titleKey?: string;
  /** 不翻译的专有名词标题(Base URL / API Key / SKILL.md),页面里也是字面量。 */
  readonly label?: string;
  /** 逗号分隔的同义词(`settings:nav_search.keywords.<名>`):只补用户会搜、标题里却没有的词。 */
  readonly keywordsKey?: string;
  /** 位于该页「高级设置」折叠区内:面包屑加后缀,定位时未展开则先展开。 */
  readonly advanced?: boolean;
  /** 位于页内分段标签(SegmentedTabs)之下:该标签文字的 i18n key,定位前先切到它。 */
  readonly tabKey?: string;
  /** 页面级条目:定位即页面本身,不找行。 */
  readonly page?: boolean;
}

type Translate = (key: string) => string;

type RowOptions = { advanced?: boolean; keywords?: string; tab?: string };

function locate(page: SettingsPageKey): Pick<SettingsSearchEntry, "section" | "sub"> {
  const [section, sub] = page.split("/") as [SettingsTabId, string | undefined];
  return sub ? { section, sub } : { section };
}

function keywordsKey(name: string | undefined): string | undefined {
  return name ? `settings:nav_search.keywords.${name}` : undefined;
}

/** 普通设置行:titleKey 省略 `settings:` 前缀。 */
function row(page: SettingsPageKey, titleKey: string, options: RowOptions = {}): SettingsSearchEntry {
  return {
    ...locate(page),
    titleKey: `settings:${titleKey}`,
    keywordsKey: keywordsKey(options.keywords),
    advanced: options.advanced,
    tabKey: options.tab,
  };
}

function literal(page: SettingsPageKey, label: string, options: RowOptions = {}): SettingsSearchEntry {
  return { ...locate(page), label, keywordsKey: keywordsKey(options.keywords), advanced: options.advanced };
}

/** 页面级条目的同义词(页键 → keywords 名)。 */
const PAGE_KEYWORDS: Partial<Record<SettingsPageKey, string>> = {
  assistants: "assistants",
  "models/providers": "providers",
  "network/search": "web_search",
  "network/proxy": "proxy",
  "extensions/mcp": "mcp",
  "extensions/skills": "skills",
  "extensions/injection": "injection",
  "extensions/quick": "quick",
  "personalization/appearance": "appearance",
  "personalization/shortcuts": "shortcuts",
  "speech/tts": "tts",
  "speech/asr": "asr",
  memory: "memory",
  "data/backup": "backup",
  "data/server": "web_service",
  "stats/logs": "logs",
  donate: "donate",
};

const PAGE_ENTRIES: readonly SettingsSearchEntry[] = SETTINGS_NAV.flatMap((item): SettingsSearchEntry[] => {
  const subs = settingsSubItems(item.id);
  if (subs.length === 0) {
    return [{ section: item.id, titleKey: item.labelKey, page: true, keywordsKey: keywordsKey(PAGE_KEYWORDS[item.id as SettingsPageKey]) }];
  }
  return subs.map((sub) => ({
    section: item.id,
    sub: sub.id,
    titleKey: sub.labelKey,
    page: true,
    keywordsKey: keywordsKey(PAGE_KEYWORDS[`${item.id}/${sub.id}` as SettingsPageKey]),
  }));
});

const ADV = { advanced: true } as const;
const MODE_TAB = "settings:mcp.tab.mode";
const LOREBOOK_TAB = "settings:mcp.tab.lorebook";

const ROW_ENTRIES: readonly SettingsSearchEntry[] = [
  // 通用
  row("general/profile", "general.avatar"),
  row("general/profile", "general.nickname", { keywords: "nickname" }),
  row("general/app", "general.display_title"),
  row("general/app", "general.opt.show_user_avatar"),
  row("general/app", "general.opt.show_model_name"),
  row("general/app", "general.opt.show_model_icon"),
  row("general/app", "general.opt.show_assistant_bubble"),
  row("general/app", "general.opt.show_token_usage"),
  row("general/app", "general.opt.auto_scroll"),
  row("general/app", "general.shell_title", { keywords: "shell" }),
  row("general/app", "general.shell_path"),
  row("general/app", "general.tray_title"),
  row("general/app", "general.minimize_to_tray", { keywords: "tray" }),

  // 助手
  row("assistants", "assistants.basic_title"),
  row("assistants", "assistants.system_prompt", { keywords: "system_prompt" }),
  row("assistants", "assistants.switches_title"),
  row("assistants", "assistants.opt.use_avatar"),
  row("assistants", "assistants.opt.stream_output"),
  row("assistants", "assistants.opt.time_reminder", ADV),
  row("assistants", "assistants.opt.allow_conv_prompt", ADV),
  row("assistants", "assistants.opt.allow_conv_injection", ADV),
  row("assistants", "assistants.opt.recent_chats", ADV),
  row("assistants", "assistants.local_tools_title", ADV),
  row("assistants", "assistants.tools.time_info.title", ADV),
  row("assistants", "assistants.tools.clipboard.title", ADV),
  row("assistants", "assistants.tools.ask_user.title", ADV),
  row("assistants", "assistants.request_params_title", ADV),
  row("assistants", "assistants.temperature", ADV),
  row("assistants", "assistants.top_p", ADV),
  row("assistants", "assistants.max_tokens", { advanced: true, keywords: "max_tokens" }),
  row("assistants", "assistants.context_message_size", { advanced: true, keywords: "context_size" }),
  row("assistants", "assistants.content_title", ADV),
  row("assistants", "assistants.message_template_title", ADV),
  row("assistants", "assistants.preset_messages_title", ADV),
  row("assistants", "assistants.regex_title", ADV),
  row("assistants", "assistants.custom_request_title", ADV),
  row("assistants", "assistants.headers", ADV),
  row("assistants", "assistants.bodies", ADV),

  // 模型 › 供应商
  row("models/providers", "providers.connection_title"),
  row("models/providers", "providers.type"),
  literal("models/providers", "Base URL", { keywords: "base_url" }),
  literal("models/providers", "API Key", { keywords: "api_key" }),
  row("models/providers", "providers.get_key_title"),
  row("models/providers", "providers.models_title"),
  row("models/providers", "providers.fetch_models"),
  row("models/providers", "providers.test_title"),
  row("models/providers", "providers.test_model"),
  row("models/providers", "providers.chat_completions_path_label", ADV),
  row("models/providers", "providers.responses_path_label", ADV),
  row("models/providers", "providers.history_reasoning_title", ADV),
  row("models/providers", "providers.prompt_cache_key_title", ADV),
  row("models/providers", "providers.prompt_cache_title", ADV),
  row("models/providers", "providers.cache_ttl", ADV),
  row("models/providers", "providers.balance_title", { advanced: true, keywords: "balance" }),
  row("models/providers", "providers.balance_api_path", ADV),
  row("models/providers", "providers.balance_result_path", ADV),

  // 模型 › 场景模型
  row("models/scenes", "models.feature.chat.title"),
  row("models/scenes", "models.feature.optimize.title"),
  row("models/scenes", "models.feature.fast.title", { keywords: "fast_model" }),
  row("models/scenes", "models.feature.translate.title"),
  row("models/scenes", "models.feature.compress.title"),
  row("models/scenes", "models.feature.ocr.title"),
  row("models/scenes", "models.feature.image.title"),

  // 网络
  row("network/search", "search.type"),
  literal("network/search", "API Key", { keywords: "api_key" }),
  row("network/search", "search.field.mode"),
  row("network/search", "search.field.engines"),
  row("network/search", "search.field.language"),
  row("network/search", "search.field.username"),
  row("network/search", "search.field.password"),
  row("network/search", "search.field.search_script"),
  row("network/search", "search.field.scrape_script"),
  row("network/search", "search.request_url", ADV),
  row("network/search", "search.depth", ADV),
  row("network/search", "search.result_count", ADV),
  row("network/proxy", "proxy.http_title"),
  row("network/proxy", "proxy.mode", { keywords: "proxy" }),
  row("network/proxy", "proxy.current"),
  row("network/proxy", "proxy.address"),
  row("network/proxy", "proxy.bypass_rules", { keywords: "bypass" }),
  row("network/proxy", "proxy.test"),
  row("network/port", "proxy.port_title", { keywords: "port" }),
  row("network/port", "proxy.port_number"),
  row("network/port", "proxy.ua_title", { keywords: "user_agent" }),
  row("network/port", "proxy.ua_label"),

  // 拓展
  row("extensions/mcp", "mcp.connection_title"),
  row("extensions/mcp", "mcp.transport"),
  row("extensions/mcp", "mcp.server.url"),
  row("extensions/mcp", "mcp.oauth.title"),
  row("extensions/mcp", "mcp.server.tools_title"),
  row("extensions/mcp", "mcp.server.headers", ADV),
  literal("extensions/skills", "SKILL.md"),
  row("extensions/skills", "mcp.file_list", ADV),
  row("extensions/injection", "mcp.tab.mode", { tab: MODE_TAB }),
  row("extensions/injection", "mcp.tab.lorebook", { keywords: "lorebook", tab: LOREBOOK_TAB }),
  row("extensions/injection", "mcp.position", { tab: MODE_TAB }),
  row("extensions/injection", "mcp.role", { tab: MODE_TAB }),
  row("extensions/injection", "mcp.inject_depth", { tab: MODE_TAB }),
  row("extensions/injection", "mcp.inject_content", { tab: MODE_TAB }),
  row("extensions/injection", "mcp.priority", { advanced: true, tab: MODE_TAB }),
  row("extensions/injection", "mcp.lorebook.enable", { advanced: true, tab: LOREBOOK_TAB }),

  // 个性化
  row("personalization/appearance", "general.font_title"),
  row("personalization/appearance", "general.ui_font"),
  row("personalization/appearance", "general.chat_font"),
  row("personalization/appearance", "general.ui_font_size", { keywords: "font_size" }),
  row("personalization/shortcuts", "general.opt.send_on_enter", { keywords: "send_on_enter" }),
  row("personalization/shortcuts", "hotkeys.actions.newConversation"),
  row("personalization/shortcuts", "hotkeys.actions.prevConversation"),
  row("personalization/shortcuts", "hotkeys.actions.nextConversation"),
  row("personalization/shortcuts", "hotkeys.actions.renameConversation"),
  row("personalization/shortcuts", "hotkeys.actions.searchConversations"),
  row("personalization/shortcuts", "hotkeys.actions.openSettings"),
  row("personalization/shortcuts", "hotkeys.actions.openImageGeneration"),
  row("personalization/shortcuts", "hotkeys.actions.zoomInOut"),

  // 语音
  row("speech/tts", "speech.read_filter_title"),
  row("speech/tts", "speech.only_read_quoted"),
  row("speech/tts", "speech.skip_brackets"),
  row("speech/tts", "speech.test", { keywords: "tts_test" }),

  // 记忆
  row("memory", "memory.write_strategy_title"),
  row("memory", "memory.global_title"),
  row("memory", "memory.global_enable"),
  row("memory", "memory.assistant_title"),

  // 数据管理
  row("data/backup", "data.backup_title"),
  row("data/backup", "data.export_backup"),
  row("data/backup", "data.import_backup", { keywords: "import_backup" }),
  row("data/backup", "data.webdav_title", { keywords: "webdav" }),
  row("data/backup", "data.server_url"),
  row("data/backup", "data.backup_path"),
  row("data/backup", "data.username"),
  row("data/backup", "data.password"),
  row("data/backup", "data.s3_title", { keywords: "s3" }),
  row("data/backup", "data.endpoint_label"),
  row("data/backup", "data.s3.region"),
  row("data/backup", "data.s3.bucket"),
  row("data/backup", "data.s3.access_key_id"),
  row("data/backup", "data.s3.secret_access_key"),
  row("data/backup", "data.s3.path_style"),
  row("data/server", "data.web_password_title", { keywords: "web_password" }),

  // 统计日志 / 关于
  row("stats/usage", "stats.heatmap"),
  row("stats/usage", "stats.model_usage"),
  row("stats/usage", "stats.request_groups"),
  row("stats/usage", "stats.provider_requests"),
  row("stats/logs", "logs.clear"),
  row("about", "about.version"),
  row("about", "about.check_update", { keywords: "update" }),
];

export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [...PAGE_ENTRIES, ...ROW_ENTRIES];

export interface SettingsSearchResult {
  readonly entry: SettingsSearchEntry;
  /** 结果行与页面定位共用的标题文字。 */
  readonly title: string;
  /** 「一级 › 二级」;行条目另加「· 高级设置」。页面级二级条目只到一级,无二级的一级页为空串。 */
  readonly breadcrumb: string;
  readonly score: number;
}

export function settingsSearchTitle(entry: SettingsSearchEntry, t: Translate): string {
  return entry.label ?? t(entry.titleKey!);
}

function breadcrumbOf(entry: SettingsSearchEntry, t: Translate): string {
  // 无二级的一级页面:标题就是一级名,再写一遍面包屑是噪音。
  if (entry.page && !entry.sub) return "";
  const nav = SETTINGS_NAV.find((item) => item.id === entry.section)!;
  const parts = [t(nav.labelKey)];
  if (!entry.page && entry.sub) {
    const sub = settingsSubItems(entry.section).find((item) => item.id === entry.sub);
    if (sub) parts.push(t(sub.labelKey));
  }
  const trail = parts.join(" › ");
  return entry.advanced ? `${trail} · ${t("settings:nav_search.advanced_suffix")}` : trail;
}

/**
 * 打分:标题全等 4 > 标题前缀 3 > 标题包含 2 > 面包屑包含 1 > 同义词包含 0.5;0 分不出现。
 * 同分保持索引表顺序(页面条目在前,行按页面内顺序)。空查询返回空。
 */
export function searchSettings(query: string, t: Translate): SettingsSearchResult[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  const scored: SettingsSearchResult[] = [];
  for (const entry of SETTINGS_SEARCH_INDEX) {
    const title = settingsSearchTitle(entry, t);
    const breadcrumb = breadcrumbOf(entry, t);
    const lowerTitle = title.toLocaleLowerCase();
    let score = 0;
    if (lowerTitle === q) score = 4;
    else if (lowerTitle.startsWith(q)) score = 3;
    else if (lowerTitle.includes(q)) score = 2;
    else if (breadcrumb.toLocaleLowerCase().includes(q)) score = 1;
    else if (entry.keywordsKey) {
      const keywords = t(entry.keywordsKey)
        .split(/[,，]/)
        .map((word) => word.trim().toLocaleLowerCase())
        .filter(Boolean);
      if (keywords.some((word) => word.includes(q))) score = 0.5;
    }
    if (score > 0) scored.push({ entry, title, breadcrumb, score });
  }
  // Array.prototype.sort 稳定:同分维持表内顺序。
  return scored.sort((a, b) => b.score - a.score);
}
