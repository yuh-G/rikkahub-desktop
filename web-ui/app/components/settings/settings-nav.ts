// 设置页导航的**唯一数据源**。纯数据 + 纯函数,不 import 任何组件/React 运行时,
// 以便未来被「设置页搜索索引」「深链解析」「快捷键」等模块安全引用,而不把它们拖进
// 组件的依赖图。
//
// 铁律:一级/二级的清单与分组只在这里改。布局、渲染派发一律从这张表推导,
// 不许在路由或组件里再写一份影子列表(两处列表 = 必然漂移)。
import {
  Bot,
  Brain,
  CheckCircle2,
  CopyPlus,
  Database,
  FileClock,
  Globe,
  Heart,
  KeyRound,
  Mic,
  Search,
  Settings2,
  UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface SettingsSubItem {
  /** 二级 id:英文短横线小写。进 URL 参数 / 未来搜索索引,不宜再改。 */
  readonly id: string;
  readonly labelKey: string;
}

export interface SettingsNavItem {
  /** 一级 id:英文短横线小写。进 URL 参数(?section=)、搜索索引;停留位置只记内存,不持久化。 */
  readonly id: string;
  readonly labelKey: string;
  readonly icon: LucideIcon;
  /** 无二级则**省略**(不要给空数组):children?.length 一处判空,语义单一。 */
  readonly children?: readonly SettingsSubItem[];
}

export const SETTINGS_NAV = [
  { id: "general", labelKey: "settings:nav.general", icon: UserRound },
  { id: "assistants", labelKey: "settings:nav.assistants", icon: Bot },
  { id: "providers", labelKey: "settings:nav.providers", icon: KeyRound },
  { id: "models", labelKey: "settings:nav.models", icon: Settings2 },
  { id: "search", labelKey: "settings:nav.search", icon: Search },
  { id: "mcp", labelKey: "settings:nav.mcp", icon: CopyPlus },
  { id: "speech", labelKey: "settings:nav.speech", icon: Mic },
  { id: "memory", labelKey: "settings:nav.memory", icon: Brain },
  { id: "data", labelKey: "settings:nav.data", icon: Database },
  { id: "stats", labelKey: "settings:nav.stats", icon: Database },
  { id: "logs", labelKey: "settings:nav.logs", icon: FileClock },
  { id: "proxy", labelKey: "settings:nav.proxy", icon: Globe },
  { id: "donate", labelKey: "settings:nav.donate", icon: Heart },
  { id: "about", labelKey: "settings:nav.about", icon: CheckCircle2 },
] as const satisfies readonly SettingsNavItem[];

/**
 * 一级 id 联合类型,从表推导——用户改表则类型自动跟随,不会出现"加了项没加类型"的漏网。
 * `as const` 不可省:单靠 `satisfies` 时数组元素的 id 仍被拓宽成 string,本类型会退化为
 * string,注册表的 Record<SettingsTabId,…> 缺键检查随之静默失效。
 */
export type SettingsTabId = (typeof SETTINGS_NAV)[number]["id"];

/** 运行时守卫:把来路不明的字符串(URL 参数等)安全收窄成 SettingsTabId。 */
export function isSettingsTabId(value: string): value is SettingsTabId {
  return SETTINGS_NAV.some((item) => item.id === value);
}
