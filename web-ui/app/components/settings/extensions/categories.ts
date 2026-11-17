// 拓展类别表:「拓展」有哪几类、按什么顺序,只在这里改(D19)。纯数据,零组件依赖——
// settings-nav.ts 直接拿它当拓展一级的二级清单;助手的「拓展管理」弹窗与输入框的
// 「MCP 与拓展」选择器按它排页签,各自的组件映射用 Record<ExtensionCategoryId, …>,
// 漏登记一类即编译不过。
export const EXTENSION_CATEGORIES = [
  { id: "mcp", labelKey: "settings:subnav.extensions.mcp" },
  { id: "skills", labelKey: "settings:subnav.extensions.skills" },
  { id: "injection", labelKey: "settings:subnav.extensions.injection" },
  { id: "quick", labelKey: "settings:subnav.extensions.quick" },
] as const;

export type ExtensionCategoryId = (typeof EXTENSION_CATEGORIES)[number]["id"];
