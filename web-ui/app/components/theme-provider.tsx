import { createContext, useContext, useEffect, useState } from "react";

export type ThemeMode = "dark" | "light" | "system";
export type Theme = ThemeMode;

// 内置色主题(只有这几种写死在 app.css 里)
export type BuiltinColorTheme = "default" | "claude" | "mono";
export const BUILTIN_COLOR_THEMES: BuiltinColorTheme[] = ["default", "claude", "mono"];

// colorTheme 是内置主题名(default/claude/mono)或用户主题的 id("user-xxx"),所以用 string。
export type ColorTheme = string;

export type CustomThemeCss = {
  light: string;
  dark: string;
};

// 一条用户自定义主题。id 同时作为 data-theme 的值,CSS 注入时按它做作用域隔离,
// 因此多个自定义主题可以并存、互不污染,切换时只有被选中的那条生效。
export type UserTheme = {
  id: string;
  name: string;
  css: CustomThemeCss;
};

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: ThemeMode;
  defaultColorTheme?: ColorTheme;
  storageKey?: string;
};

type ThemeProviderState = {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  colorTheme: ColorTheme;
  setColorTheme: (theme: ColorTheme) => void;
  userThemes: UserTheme[];
  addUserTheme: (data: { name: string; css: CustomThemeCss }) => UserTheme;
  updateUserTheme: (id: string, patch: { name?: string; css?: CustomThemeCss }) => void;
  deleteUserTheme: (id: string) => void;
};

const initialState: ThemeProviderState = {
  theme: "system",
  colorTheme: "default",
  userThemes: [],
  setTheme: () => null,
  setColorTheme: () => null,
  addUserTheme: () => ({ id: "", name: "", css: { light: "", dark: "" } }),
  updateUserTheme: () => null,
  deleteUserTheme: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

const COLOR_THEME_STORAGE_SUFFIX = "-color";
const USER_THEMES_STORAGE_SUFFIX = "-user-themes";
const LEGACY_CUSTOM_LIGHT_SUFFIX = "-custom-light";
const LEGACY_CUSTOM_DARK_SUFFIX = "-custom-dark";
const CUSTOM_THEME_STYLE_ID = "rikkahub-custom-theme";

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

function generateUserThemeId(): string {
  return `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function removeBlacklistedCss(value: string): string {
  return value
    .replace(/@theme\s+inline\s*\{[\s\S]*?\}/g, "")
    .replace(/(^|\n)\s*body\s*\{[\s\S]*?\}/g, "")
    .trim();
}

// 把一段用户 CSS 收进 :root[data-theme="<id>"] / :root.dark[data-theme="<id>"] 作用域下,
// 让它只在对应主题被选中时生效,不污染内置主题或其他用户主题。
function scopeCssForTheme(
  value: string,
  dataThemeId: string,
  mode: "light" | "dark",
): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const filtered = removeBlacklistedCss(trimmed);
  if (!filtered) return "";
  const scopeAttr = `[data-theme="${dataThemeId}"]`;

  if (mode === "light") {
    const scoped = filtered.replace(
      /(^|\n)\s*:root(?!\.dark)(?!\[data-theme=)\s*\{/g,
      `$1:root${scopeAttr} {`,
    );
    if (/:root\[data-theme=/.test(scoped)) return scoped;
    return `:root${scopeAttr} {\n${filtered}\n}`;
  }

  const scopedDarkRoot = filtered.replace(
    /(^|\n)\s*:root\.dark(?!\[data-theme=)\s*\{/g,
    `$1:root.dark${scopeAttr} {`,
  );
  const scoped = scopedDarkRoot.replace(
    /(^|\n)\s*\.dark(?![a-zA-Z0-9_-])\s*\{/g,
    `$1:root.dark${scopeAttr} {`,
  );
  if (/:root\.dark\[data-theme=/.test(scoped)) return scoped;
  return `:root.dark${scopeAttr} {\n${filtered}\n}`;
}

// 读取并归一化用户主题列表。首次发现旧版单槽 custom 数据时,自动迁移成一条
// 名为"自定义"的用户主题,老用户不会丢失已配置的主题。
function readUserThemes(storageKey: string): UserTheme[] {
  const userThemesKey = `${storageKey}${USER_THEMES_STORAGE_SUFFIX}`;
  const raw = localStorage.getItem(userThemesKey);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is UserTheme =>
            !!item &&
            typeof item.id === "string" &&
            typeof item.name === "string" &&
            typeof item.css === "object" &&
            item.css !== null &&
            typeof item.css.light === "string" &&
            typeof item.css.dark === "string",
        );
      }
    } catch {
      // fall through to legacy migration
    }
  }

  const legacyLight = localStorage.getItem(`${storageKey}${LEGACY_CUSTOM_LIGHT_SUFFIX}`);
  const legacyDark = localStorage.getItem(`${storageKey}${LEGACY_CUSTOM_DARK_SUFFIX}`);
  if ((legacyLight && legacyLight.trim()) || (legacyDark && legacyDark.trim())) {
    const migrated: UserTheme[] = [
      {
        id: generateUserThemeId(),
        name: "自定义",
        css: { light: legacyLight ?? "", dark: legacyDark ?? "" },
      },
    ];
    localStorage.setItem(userThemesKey, JSON.stringify(migrated));
    localStorage.removeItem(`${storageKey}${LEGACY_CUSTOM_LIGHT_SUFFIX}`);
    localStorage.removeItem(`${storageKey}${LEGACY_CUSTOM_DARK_SUFFIX}`);
    return migrated;
  }

  return [];
}

// 决定初始 colorTheme:兜底已删除的内置主题、旧版 "custom"、以及指向不存在用户主题的脏值。
function resolveInitialColorTheme(storageKey: string, userThemes: UserTheme[]): ColorTheme {
  const stored = localStorage.getItem(`${storageKey}${COLOR_THEME_STORAGE_SUFFIX}`);
  if (!stored) return "default";

  // 旧版固定槽 "custom" → 映射到迁移后的第一条用户主题
  if (stored === "custom") return userThemes[0]?.id ?? "default";
  // 已移除的内置主题
  if (stored === "t3-chat" || stored === "bubblegum") return "default";
  // 指向不存在用户主题的脏值
  if (stored.startsWith("user-")) {
    return userThemes.some((u) => u.id === stored) ? stored : "default";
  }
  return BUILTIN_COLOR_THEMES.includes(stored as BuiltinColorTheme) ? stored : "default";
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  defaultColorTheme = "default",
  storageKey = "vite-ui-theme",
  ...props
}: ThemeProviderProps) {
  const colorThemeStorageKey = `${storageKey}${COLOR_THEME_STORAGE_SUFFIX}`;
  const userThemesStorageKey = `${storageKey}${USER_THEMES_STORAGE_SUFFIX}`;

  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(storageKey);
    return isThemeMode(stored) ? stored : defaultTheme;
  });

  const [userThemes, setUserThemes] = useState<UserTheme[]>(() => readUserThemes(storageKey));

  const [colorTheme, setColorThemeState] = useState<ColorTheme>(() =>
    resolveInitialColorTheme(storageKey, userThemes),
  );

  useEffect(() => {
    const root = window.document.documentElement;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const applyMode = (mode: ThemeMode) => {
      root.classList.remove("light", "dark");

      if (mode === "system") {
        root.classList.add(mediaQuery.matches ? "dark" : "light");
        return;
      }

      root.classList.add(mode);
    };

    applyMode(theme);

    if (theme !== "system") {
      return;
    }

    const onSystemThemeChange = () => {
      applyMode("system");
    };

    mediaQuery.addEventListener("change", onSystemThemeChange);

    return () => {
      mediaQuery.removeEventListener("change", onSystemThemeChange);
    };
  }, [theme]);

  useEffect(() => {
    const root = window.document.documentElement;
    root.dataset.theme = colorTheme;
  }, [colorTheme]);

  // 把所有用户主题的 CSS 同时注入到同一个 <style>:每条按自己的 data-theme 作用域隔离,
  // 只有当前 colorTheme 匹配的那条才真正生效,切换主题零延迟、无需重新注入。
  useEffect(() => {
    const blocks = userThemes
      .map((ut) => {
        const light = scopeCssForTheme(ut.css.light, ut.id, "light");
        const dark = scopeCssForTheme(ut.css.dark, ut.id, "dark");
        return [light, dark].filter(Boolean).join("\n\n");
      })
      .filter(Boolean)
      .join("\n\n");

    const existing = document.getElementById(CUSTOM_THEME_STYLE_ID);

    if (!blocks) {
      existing?.remove();
      return;
    }

    const styleElement = existing ?? document.createElement("style");
    styleElement.id = CUSTOM_THEME_STYLE_ID;
    styleElement.textContent = blocks;

    if (!existing) {
      document.head.appendChild(styleElement);
    }
  }, [userThemes]);

  useEffect(() => {
    localStorage.setItem(userThemesStorageKey, JSON.stringify(userThemes));
  }, [userThemes, userThemesStorageKey]);

  const setTheme = (next: ThemeMode) => {
    localStorage.setItem(storageKey, next);
    setThemeState(next);
  };

  const setColorTheme = (next: ColorTheme) => {
    localStorage.setItem(colorThemeStorageKey, next);
    setColorThemeState(next);
  };

  const addUserTheme = ({ name, css }: { name: string; css: CustomThemeCss }): UserTheme => {
    const created: UserTheme = {
      id: generateUserThemeId(),
      name: name.trim() || "未命名主题",
      css,
    };
    setUserThemes((prev) => [...prev, created]);
    return created;
  };

  const updateUserTheme = (
    id: string,
    patch: { name?: string; css?: CustomThemeCss },
  ) => {
    setUserThemes((prev) =>
      prev.map((u) =>
        u.id === id
          ? {
              ...u,
              ...patch,
              name: patch.name !== undefined ? patch.name.trim() || u.name : u.name,
            }
          : u,
      ),
    );
  };

  const deleteUserTheme = (id: string) => {
    setUserThemes((prev) => prev.filter((u) => u.id !== id));
    // 删的恰好是当前主题 → 回退到默认,避免界面卡在一个已无 CSS 的作用域上
    if (colorTheme === id) {
      setColorTheme("default");
    }
  };

  const value: ThemeProviderState = {
    theme,
    setTheme,
    colorTheme,
    setColorTheme,
    userThemes,
    addUserTheme,
    updateUserTheme,
    deleteUserTheme,
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined) throw new Error("useTheme must be used within a ThemeProvider");

  return context;
};
