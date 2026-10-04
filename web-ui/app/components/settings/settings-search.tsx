// 设置侧栏的搜索:输入框 + 结果列表(有输入时整体替换导航列表),以及选中后在页面里定位
// 设置项的 hook。两套外壳(模态 / 窄屏整页)共用,外壳只负责「跳到哪一页」。
// 索引与打分见 settings-search-index.ts。
import * as React from "react";
import { SearchX } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SETTINGS_PAGE_PANEL_ID, SettingsNavList } from "~/components/settings/settings-panel";
import { settingsNavItem, settingsPageKey, type SettingsTabId } from "~/components/settings/settings-nav";
import { searchSettings, type SettingsSearchEntry } from "~/components/settings/settings-search-index";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SearchInput } from "~/components/ui/search-input";
import { cn } from "~/lib/utils";
import {
  clearSettingsFocus,
  requestSettingsFocus,
  setSettingsNavQuery,
  useSettingsDialogStore,
} from "~/stores/settings-dialog-store";

/**
 * 侧栏导航区:搜索框在上,下面是导航列表或搜索结果。`onLocate` 由外壳实现跳页;
 * `focusShortcut` 开启 Ctrl+F 聚焦搜索框(仅模态——整页形态下 Ctrl+F 留给浏览器查找)。
 */
export function SettingsSidebarNav({
  active,
  onSelect,
  onLocate,
  focusShortcut = false,
  listClassName,
}: {
  active: SettingsTabId;
  onSelect: (section: SettingsTabId) => void;
  onLocate: (section: SettingsTabId, sub: string | null) => void;
  focusShortcut?: boolean;
  listClassName?: string;
}) {
  const { t } = useTranslation();
  const query = useSettingsDialogStore((state) => state.navQuery);
  const results = React.useMemo(() => searchSettings(query, t), [query, t]);
  const [highlight, setHighlight] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();
  const optionId = (index: number) => `${listId}-${index}`;

  React.useEffect(() => setHighlight(0), [query]);

  React.useEffect(() => {
    if (!focusShortcut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.code !== "KeyF") return;
      event.preventDefault();
      event.stopPropagation();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [focusShortcut]);

  React.useEffect(() => {
    if (!query) return;
    document.getElementById(optionId(highlight))?.scrollIntoView({ block: "nearest" });
    // optionId 只依赖稳定的 listId。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight, query]);

  const pick = (entry: SettingsSearchEntry, title: string) => {
    const sub = entry.sub ?? null;
    requestSettingsFocus(
      entry.page
        ? null
        : { page: settingsPageKey(entry.section, sub), title, advanced: entry.advanced === true, tab: entry.tabKey ? t(entry.tabKey) : undefined },
    );
    onLocate(entry.section, sub);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // 模态里由 Radix 的 Esc 守卫先清空(见 settings-dialog.tsx);整页形态在这里清。
      if (query) {
        event.preventDefault();
        setSettingsNavQuery("");
      }
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((index) => (index + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const result = results[highlight];
      if (result) pick(result.entry, result.title);
    }
  };

  return (
    <>
      <div className="shrink-0 px-2.5 pb-2">
        <SearchInput
          ref={inputRef}
          value={query}
          onValueChange={setSettingsNavQuery}
          clearLabel={t("settings:nav_search.clear")}
          placeholder={t("settings:nav_search.placeholder")}
          aria-label={t("settings:nav_search.placeholder")}
          role="combobox"
          aria-expanded={query ? true : false}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={query && results.length > 0 ? optionId(highlight) : undefined}
          onKeyDown={onKeyDown}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {!query ? (
          <SettingsNavList active={active} onSelect={onSelect} className={listClassName} />
        ) : results.length === 0 ? (
          <div id={listId} className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <SearchX aria-hidden className="size-8 text-[var(--ds-icon)] opacity-40" />
            <p className="text-sm text-[var(--ds-text-tertiary)]">{t("settings:nav_search.no_results")}</p>
          </div>
        ) : (
          <div
            id={listId}
            role="listbox"
            aria-label={t("settings:nav_search.results_label")}
            className={cn("space-y-0.5", listClassName)}
          >
            {results.map((result, index) => {
              const Icon = settingsNavItem(result.entry.section).icon;
              const selected = index === highlight;
              return (
                <div
                  key={index}
                  id={optionId(index)}
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-3 rounded-[var(--ds-radius-md)] px-3 py-2 text-left",
                    selected && "bg-[var(--ds-on-surface)]",
                  )}
                  // mousedown 阻止输入框失焦:键盘与鼠标可以混用,选完焦点仍在原处。
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setHighlight(index)}
                  onClick={() => pick(result.entry, result.title)}
                >
                  <Icon aria-hidden className="size-[1.125rem] shrink-0 text-[var(--ds-icon)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[var(--ds-text-primary)]">{result.title}</div>
                    {result.breadcrumb ? (
                      <div className="truncate text-[11px] text-[var(--ds-text-tertiary)]">{result.breadcrumb}</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </>
  );
}

const FLASH_ATTR = "data-settings-flash";
const LOCATE_TIMEOUT_MS = 2000;
const LOCATE_INTERVAL_MS = 50;

function isVisible(element: Element): boolean {
  // hidden / display:none 祖先下的元素没有布局盒(提示词注入页两个编辑器常驻挂载、hidden 切换)。
  return element.getClientRects().length > 0;
}

function textOf(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 按标题文字找设置项:设置行标题(data-settings-label)> 按钮式设置项 / 页内标签的文字。
 * 先全等,再允许设置行标题带后缀(「请求地址 — 必填」、标题旁的状态徽标)。
 */
function findSettingsItem(panel: HTMLElement, title: string): HTMLElement | null {
  const candidates = Array.from(
    panel.querySelectorAll<HTMLElement>('[data-settings-label], button, [role="tab"]'),
  ).filter(isVisible);
  const hit =
    candidates.find((element) => element.hasAttribute("data-settings-label") && textOf(element) === title) ??
    candidates.find((element) => textOf(element) === title) ??
    candidates.find((element) => element.hasAttribute("data-settings-label") && textOf(element).startsWith(title));
  if (!hit) return null;
  return hit.hasAttribute("data-settings-label")
    ? (hit.closest<HTMLElement>("[data-settings-item]") ?? hit)
    : hit;
}

function flashSettingsItem(element: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  // 连续选中同一项:先摘掉再强制回流,动画才会重放。
  element.removeAttribute(FLASH_ATTR);
  void element.offsetWidth;
  element.setAttribute(FLASH_ATTR, "");
  window.setTimeout(() => element.removeAttribute(FLASH_ATTR), 1400);
}

/**
 * 搜索选中后在当前页里定位设置项:按需切到页内标签、展开高级设置,找到后滚到视区中央并闪烁。
 * 页面内容可能异步到达(设置快照、列表详情),所以短轮询直到找到或超时;超时静默放弃
 * (例如列表页还没有任何条目,详情里自然没有这一行)。
 */
export function useSettingsSearchFocus(pageKey: string): void {
  const target = useSettingsDialogStore((state) => state.focusTarget);
  React.useEffect(() => {
    if (!target || target.page !== pageKey) return;
    let timer = 0;
    let tabDone = !target.tab;
    let expanded = false;
    const deadline = performance.now() + LOCATE_TIMEOUT_MS;
    const step = () => {
      const panel = document.getElementById(SETTINGS_PAGE_PANEL_ID);
      if (panel) {
        if (!tabDone) {
          const tab = Array.from(panel.querySelectorAll<HTMLElement>('[role="tab"]')).find(
            (element) => isVisible(element) && textOf(element) === target.tab,
          );
          if (tab) {
            tabDone = true;
            if (tab.getAttribute("aria-selected") !== "true") {
              tab.click();
              // 切标签后等下一轮再找:被切出来的编辑器这时才有布局盒。
              timer = window.setTimeout(step, LOCATE_INTERVAL_MS);
              return;
            }
          }
        }
        const item = tabDone ? findSettingsItem(panel, target.title) : null;
        if (item) {
          flashSettingsItem(item);
          clearSettingsFocus();
          return;
        }
        if (tabDone && target.advanced && !expanded) {
          const toggle = Array.from(
            panel.querySelectorAll<HTMLElement>('[data-settings-advanced][aria-expanded="false"]'),
          ).find(isVisible);
          if (toggle) {
            expanded = true;
            toggle.click();
          }
        }
      }
      if (performance.now() > deadline) {
        clearSettingsFocus();
        return;
      }
      timer = window.setTimeout(step, LOCATE_INTERVAL_MS);
    };
    timer = window.setTimeout(step, 0);
    return () => window.clearTimeout(timer);
  }, [target, pageKey]);
}
