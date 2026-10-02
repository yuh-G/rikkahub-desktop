// 设置页导航的**唯一数据源**。纯数据 + 纯函数,不 import 任何组件/React 运行时,
// 以便未来被「设置页搜索索引」「深链解析」「快捷键」等模块安全引用,而不把它们拖进
// 组件的依赖图。
//
// 铁律:一级/二级的清单与分组只在这里改。布局、渲染派发一律从这张表推导,
// 不许在路由或组件里再写一份影子列表(两处列表 = 必然漂移)。
import {
  Blocks,
  Bot,
  Boxes,
  Brain,
  ChartNoAxesColumn,
  Database,
  Globe,
  Heart,
  Info,
  Mic,
  Palette,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface SettingsSubItem {
  /** 二级 id:英文短横线小写。进 URL 参数(?sub=)/ 未来搜索索引,不宜再改。 */
  readonly id: string;
  readonly labelKey: string;
}

export interface SettingsNavItem {
  /** 一级 id:英文短横线小写。进 URL 参数(?section=)、搜索索引;停留位置只记内存,不持久化。 */
  readonly id: string;
  readonly labelKey: string;
  readonly icon: LucideIcon;
  /** 无二级则**省略**(不要给空数组):二级标签栏只在有 children 时渲染,语义单一。 */
  readonly children?: readonly SettingsSubItem[];
}

export const SETTINGS_NAV = [
  {
    id: "general",
    labelKey: "settings:nav.general",
    icon: Settings,
    children: [
      { id: "profile", labelKey: "settings:subnav.general.profile" },
      { id: "app", labelKey: "settings:subnav.general.app" },
    ],
  },
  { id: "assistants", labelKey: "settings:nav.assistants", icon: Bot },
  {
    id: "models",
    labelKey: "settings:nav.models",
    icon: Boxes,
    children: [
      { id: "providers", labelKey: "settings:subnav.models.providers" },
      { id: "scenes", labelKey: "settings:subnav.models.scenes" },
    ],
  },
  {
    id: "network",
    labelKey: "settings:nav.network",
    icon: Globe,
    children: [
      { id: "search", labelKey: "settings:subnav.network.search" },
      { id: "proxy", labelKey: "settings:subnav.network.proxy" },
      { id: "port", labelKey: "settings:subnav.network.port" },
    ],
  },
  {
    id: "extensions",
    labelKey: "settings:nav.extensions",
    icon: Blocks,
    children: [
      { id: "mcp", labelKey: "settings:subnav.extensions.mcp" },
      { id: "skills", labelKey: "settings:subnav.extensions.skills" },
      { id: "injection", labelKey: "settings:subnav.extensions.injection" },
      { id: "quick", labelKey: "settings:subnav.extensions.quick" },
    ],
  },
  {
    id: "personalization",
    labelKey: "settings:nav.personalization",
    icon: Palette,
    children: [
      { id: "appearance", labelKey: "settings:subnav.personalization.appearance" },
      { id: "shortcuts", labelKey: "settings:subnav.personalization.shortcuts" },
    ],
  },
  {
    id: "speech",
    labelKey: "settings:nav.speech",
    icon: Mic,
    children: [
      { id: "tts", labelKey: "settings:subnav.speech.tts" },
      { id: "asr", labelKey: "settings:subnav.speech.asr" },
    ],
  },
  { id: "memory", labelKey: "settings:nav.memory", icon: Brain },
  {
    id: "data",
    labelKey: "settings:nav.data",
    icon: Database,
    children: [
      { id: "backup", labelKey: "settings:subnav.data.backup" },
      { id: "server", labelKey: "settings:subnav.data.server" },
    ],
  },
  {
    id: "stats",
    labelKey: "settings:nav.stats",
    icon: ChartNoAxesColumn,
    children: [
      { id: "usage", labelKey: "settings:subnav.stats.usage" },
      { id: "logs", labelKey: "settings:subnav.stats.logs" },
    ],
  },
  { id: "donate", labelKey: "settings:nav.donate", icon: Heart },
  { id: "about", labelKey: "settings:nav.about", icon: Info },
] as const satisfies readonly SettingsNavItem[];

type NavEntry = (typeof SETTINGS_NAV)[number];

/**
 * 一级 id 联合类型,从表推导——用户改表则类型自动跟随,不会出现"加了项没加类型"的漏网。
 * `as const` 不可省:单靠 `satisfies` 时数组元素的 id 仍被拓宽成 string,本类型会退化为
 * string,注册表的缺键检查随之静默失效。
 */
export type SettingsTabId = NavEntry["id"];

/**
 * 页键:有二级的一级展开成 `一级/二级`,无二级的就是一级 id 本身。注册表以它为键,
 * 表里多一页而注册表没挂组件,typecheck 当场报缺键。
 */
export type SettingsPageKey = NavEntry extends infer E
  ? E extends { readonly id: infer P extends string; readonly children: readonly { readonly id: infer S extends string }[] }
    ? `${P}/${S}`
    : E extends { readonly id: infer P extends string }
      ? P
      : never
  : never;

/** 一级与其当前二级(无二级的一级恒为 null)。 */
export interface SettingsLocation {
  section: SettingsTabId;
  sub: string | null;
}

/** 运行时守卫:把来路不明的字符串(URL 参数等)安全收窄成 SettingsTabId。 */
export function isSettingsTabId(value: string): value is SettingsTabId {
  return SETTINGS_NAV.some((item) => item.id === value);
}

export function settingsNavItem(section: SettingsTabId): NavEntry {
  // 类型已保证 section 在表内,find 必中。
  return SETTINGS_NAV.find((item) => item.id === section)!;
}

export function settingsSubItems(section: SettingsTabId): readonly SettingsSubItem[] {
  const item = settingsNavItem(section);
  return "children" in item ? item.children : [];
}

/** 候选二级属于该一级则用之,否则落到第一个二级;无二级恒为 null。 */
export function resolveSettingsSub(section: SettingsTabId, candidate: string | null | undefined): string | null {
  const subs = settingsSubItems(section);
  if (subs.length === 0) return null;
  return subs.some((sub) => sub.id === candidate) ? candidate! : subs[0].id;
}

export function settingsPageKey(section: SettingsTabId, sub: string | null): SettingsPageKey {
  const resolved = resolveSettingsSub(section, sub);
  return (resolved ? `${section}/${resolved}` : section) as SettingsPageKey;
}

/**
 * 旧版一级 id → 新位置。老用户收藏的网页版链接、外部文档里的 ?section= 仍能落到正确页。
 * 旧 `models`(场景模型)与新一级同名,按新语义处理;站内链接一律写显式 sub,不依赖本表。
 */
const LEGACY_SECTIONS: Record<string, SettingsLocation> = {
  providers: { section: "models", sub: "providers" },
  search: { section: "network", sub: "search" },
  proxy: { section: "network", sub: "proxy" },
  logs: { section: "stats", sub: "logs" },
};

/** 旧 `mcp` 分区靠 tab 参数选编辑器;拆页后 tab 决定落到哪个二级(模式注入/世界书同在提示词注入页)。 */
const LEGACY_MCP_TABS: Record<string, string> = {
  mcp: "mcp",
  skills: "skills",
  quick: "quick",
  mode: "injection",
  lorebook: "injection",
};

/**
 * 解析 `?section=&sub=`。section 缺失或不认识 → null(调用方回落到记忆位置)。
 * 返回的 sub 是"用户指定的二级":不属于该一级时为 null,由调用方按记忆/默认补全。
 */
export function resolveSettingsLocation(search: string): SettingsLocation | null {
  const params = new URLSearchParams(search);
  const section = params.get("section");
  if (!section) return null;
  const sub = params.get("sub");
  if (isSettingsTabId(section)) {
    const valid = settingsSubItems(section).some((item) => item.id === sub);
    return { section, sub: valid ? sub : null };
  }
  if (section === "mcp") {
    return { section: "extensions", sub: LEGACY_MCP_TABS[params.get("tab") ?? ""] ?? null };
  }
  return LEGACY_SECTIONS[section] ?? null;
}
