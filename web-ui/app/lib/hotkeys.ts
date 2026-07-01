/**
 * 应用内快捷键的核心工具库。纯逻辑,无 React、无副作用。
 *
 * Token 表示:一条 binding 是字符串数组,修饰键在前(固定顺序 Ctrl→Alt→Shift→Meta),主键在最后。
 * 例:["Ctrl","N"]、["Alt","Up"]、["F2"]、["Ctrl",","]、["Ctrl","Shift","F"]。
 *
 * 数据来源:KeyboardEvent。修饰键取自事件标志位(ctrlKey/altKey/shiftKey/metaKey),主键取自
 * event.code(字母/数字/功能键/方向键)或 code→符号映射(符号键用 code 而非 key,避免 Shift 改变
 * key 的问题——Shift+5 的 key 是 "%" 但 code 是 "Digit5")。
 *
 * 默认表(DEFAULT_KEYBINDINGS)必须和后端 defaultSettings().keybindings 保持一致。
 */
import type { KeybindingAction, KeybindingEntry } from "~/types/settings";

/** 修饰键固定顺序,录制/比对都按此排序,保证 tokensEqual 可直接逐项比较。 */
export const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;
const MODIFIER_SET = new Set<string>(MODIFIER_ORDER);

/** 单纯按下修饰键(code 为 ControlLeft 等)时不构成组合,事件忽略。 */
const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
  "AltLeft", "AltRight", "MetaLeft", "MetaRight",
]);

/** code → 符号 token。符号键用 code 而非 key,避免 Shift 改变 key 的干扰。 */
const SYMBOL_CODE_MAP: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";",
  Quote: "'", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`",
};

/** code → 特殊键 token。 */
const SPECIAL_CODE_MAP: Record<string, string> = {
  Space: "Space", Enter: "Enter", Escape: "Escape", Tab: "Tab",
  Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
};

/** 默认快捷键绑定。和后端 defaultSettings().keybindings 必须一致,改动两边同步。 */
export const DEFAULT_KEYBINDINGS: Record<KeybindingAction, KeybindingEntry> = {
  newConversation: { keys: ["Ctrl", "N"], enabled: true },
  prevConversation: { keys: ["Alt", "Up"], enabled: true },
  nextConversation: { keys: ["Alt", "Down"], enabled: true },
  renameConversation: { keys: ["F2"], enabled: true },
  searchConversations: { keys: ["Ctrl", "Shift", "F"], enabled: true },
  openSettings: { keys: ["Ctrl", ","], enabled: true },
  openImageGeneration: { keys: ["Ctrl", "I"], enabled: true },
  // 滚轮缩放:固定 Ctrl+Wheel,无法录制,只有 enabled 开关。
  zoomInOut: { enabled: true },
};

/** 设置页展示顺序。 */
export const KEYBINDING_ORDER: KeybindingAction[] = [
  "newConversation",
  "prevConversation",
  "nextConversation",
  "renameConversation",
  "searchConversations",
  "openSettings",
  "openImageGeneration",
  "zoomInOut",
];

/** 从 KeyboardEvent.code + .key 提取主键 token;纯修饰键或不可绑定键返回 undefined。 */
export function codeToToken(code: string): string | undefined {
  const letter = code.match(/^Key([A-Z])$/);
  if (letter) return letter[1];
  const digit = code.match(/^(?:Digit|Numpad)(\d)$/);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  switch (code) {
    case "ArrowUp": return "Up";
    case "ArrowDown": return "Down";
    case "ArrowLeft": return "Left";
    case "ArrowRight": return "Right";
  }
  if (SYMBOL_CODE_MAP[code]) return SYMBOL_CODE_MAP[code];
  if (SPECIAL_CODE_MAP[code]) return SPECIAL_CODE_MAP[code];
  return undefined;
}

/** 从 KeyboardEvent 构建完整 token 数组(修饰键按固定顺序 + 主键)。纯修饰键按下返回空数组。 */
export function eventToTokens(event: KeyboardEvent): string[] {
  if (MODIFIER_CODES.has(event.code)) return [];
  const tokens: string[] = [];
  if (event.ctrlKey) tokens.push("Ctrl");
  if (event.altKey) tokens.push("Alt");
  if (event.shiftKey) tokens.push("Shift");
  if (event.metaKey) tokens.push("Meta");
  const main = codeToToken(event.code);
  if (main) tokens.push(main);
  return tokens;
}

/** 归一化 token 数组:修饰键按固定顺序排列在前,主键在后;去重。 */
export function normalizeTokens(tokens: string[]): string[] {
  const modifiers = MODIFIER_ORDER.filter((m) => tokens.includes(m));
  const seen = new Set<string>(modifiers);
  const mains: string[] = [];
  for (const t of tokens) {
    if (!MODIFIER_SET.has(t) && !seen.has(t)) {
      seen.add(t);
      mains.push(t);
    }
  }
  return [...modifiers, ...mains];
}

/** 两个 token 数组是否等价(归一化后逐项比)。 */
export function tokensEqual(a: string[], b: string[]): boolean {
  const na = normalizeTokens(a);
  const nb = normalizeTokens(b);
  return na.length === nb.length && na.every((t, i) => t === nb[i]);
}

/** 合法 binding:无重复;要么"至少一个修饰键 + 一个主键",要么单个功能键(F1-F12)。 */
export function isValidBinding(tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  if (new Set(tokens).size !== tokens.length) return false;
  const hasModifier = tokens.some((t) => MODIFIER_SET.has(t));
  const hasMain = tokens.some((t) => !MODIFIER_SET.has(t));
  const isSingleFunctionKey = tokens.length === 1 && /^F\d{1,2}$/.test(tokens[0]);
  return (hasModifier && hasMain) || isSingleFunctionKey;
}

/** 单个 token 的显示文本。 */
export function formatToken(token: string): string {
  switch (token) {
    case "Ctrl": return "Ctrl";
    case "Alt": return "Alt";
    case "Shift": return "Shift";
    case "Meta": return "Win";
    case "Up": return "↑";
    case "Down": return "↓";
    case "Left": return "←";
    case "Right": return "→";
    case "Enter": return "↵";
    case "Backspace": return "⌫";
    case "Delete": return "Del";
    case "Escape": return "Esc";
    case "Tab": return "⇥";
    case "Space": return "Space";
    default: return token;
  }
}

/** 完整 binding 的显示文本,如 "Ctrl+N"、"Alt+↑"、"F2"。 */
export function formatBinding(tokens: string[] | undefined): string {
  if (!tokens || tokens.length === 0) return "";
  return normalizeTokens(tokens).map(formatToken).join("+");
}

/**
 * 检测 token 是否和其它已启用的 binding 冲突。返回冲突的 action,无冲突返回 null。
 * 用于录制时实时校验 + 开关启用时校验。zoomInOut 无 keys,不参与检测。
 */
export function findConflict(
  action: KeybindingAction,
  tokens: string[],
  all: Partial<Record<KeybindingAction, KeybindingEntry>>,
): KeybindingAction | null {
  if (tokens.length === 0) return null;
  for (const otherAction of KEYBINDING_ORDER) {
    if (otherAction === action) continue;
    const entry = all[otherAction];
    if (!entry?.enabled || !entry.keys || entry.keys.length === 0) continue;
    if (tokensEqual(entry.keys, tokens)) return otherAction;
  }
  return null;
}

/** 焦点是否在文本输入元素上(input/textarea/select/contentEditable)。决定单键快捷键(F2)是否响应。 */
export function isTextInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

/** binding 是否带有修饰键(Ctrl/Alt/Shift/Meta)。用于判断输入框聚焦时是否仍响应。 */
export function hasModifier(tokens: string[]): boolean {
  return tokens.some((t) => MODIFIER_SET.has(t));
}
