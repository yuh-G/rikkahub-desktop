// hooks/use-autosave-draft.ts — 草稿防抖自动保存的统一实现(R8-2)。
//
// 病史:设置各分区(providers/assistants/search/proxy/data/extensions 五编辑器)各自复制
// 了一份"dirtyRef + 防抖 effect"样板,且保存完成回调无条件 dirtyRef=false——键击若落在
// "保存发起 → resolve"窗口内,其 dirty 标记被抹掉,下一轮防抖看到 dirty=false 直接跳过:
// 字符显示在框里、提示"已自动保存",实际永不落盘,切页即丢(本机 RTT 小难复现,Docker/
// 反代远程部署高频复现)。extensions/mcp.tsx 的 McpServerEditor 曾就地修复过一次(savingRef
// 三件套),但其余分区未同步。本 hook 把三件套抽成唯一实现,所有分区换装。
//
// 语义(三件套):
// - markDirty():每次编辑调用。置脏并(重新)安排防抖保存;若正有保存在飞,同时标记
//   "窗口内有编辑"。
// - 保存完成:dirty = 窗口内是否有编辑。有 → 立即补排下一轮防抖(键击不丢);无 → 干净。
// - 保存失败:保持脏,等下一次编辑触发重试(不自动重排,避免服务端持续失败时风暴)。
// - reset():切换编辑实体/表单重对齐时调用。若仍有防抖窗口内的脏编辑,先尽力补发一次
//   (调用约定:reset 与 setDraft(新实体) 同步发生在同一 effect/handler 内,此刻 React 尚未
//   重渲染,save 闭包看到的仍是旧实体草稿,补发不会串写到新实体),然后清空待保存状态。
// - saveNow():手动保存/测试连接前的"确保已保存"。与在飞保存串行化,绝不并发双写。
// - discard():删除当前实体前调用。丢弃待保存状态且绝不补发(补发会把已删实体 POST 回
//   detail 端点复活),并等待在飞保存收尾——保证随后的 DELETE 不会与迟到的 POST 乱序
//   (POST 后到同样复活)。与 reset 的区别:reset 面向"切换实体",脏编辑要补发;
//   discard 面向"实体即将消失",脏编辑必须丢弃。
// - 卸载:若仍有脏数据,尽力发一次保存(修复原样板"切页即丢"——旧实现卸载时只清定时器)。
//
// 域7-1(交互审查 3A)追加——失败必须外显,消灭"缺省即静默":
// - 状态外显:控制器维护 status 机(idle → pending → saving → saved/failed)并通过
//   onStatusChange 回调推给 React 层;<AutosaveStatus/> 据此渲染三态行
//   (保存中/已自动保存/保存失败+点击重试)。失败保持脏,重试=saveNow。
// - 缺省不再静默:onSaveError 省略时由 useAutosaveDraft 用 i18n 键 toast.error(
//   settings:common.autosave_failed,可带分区名覆盖);各分区旧的 console.warn 静默档
//   全部删除,只剩"显式自定义 toast"与"缺省统一 toast"两种形态。
import * as React from "react";
import { toast } from "sonner";

import i18n from "~/i18n";

/** 自动保存状态机:idle(未编辑) → pending(已置脏,防抖窗口内) → saving → saved/failed。 */
export type AutosaveStatus = "idle" | "pending" | "saving" | "saved" | "failed";

interface AutosaveScheduler {
  set: (fn: () => void, ms: number) => number;
  clear: (id: number) => void;
}

export interface AutosaveControllerOptions {
  /** 防抖延迟,默认 700ms。 */
  delayMs?: number;
  /** 防抖/卸载路径的保存失败出口(手动 saveNow 的失败直接抛给调用方)。
   *  域7-1:省略时由 useAutosaveDraft 用统一 i18n 键 toast.error——不再有静默档。 */
  onSaveError?: (error: unknown) => void;
  /** 状态跳变通知(域7-1 三态状态行的数据源)。 */
  onStatusChange?: (status: AutosaveStatus) => void;
  /** 测试注入假定时器。 */
  scheduler?: AutosaveScheduler;
}

export interface AutosaveController {
  /** 每次编辑调用:置脏 + (重新)安排防抖保存。 */
  markDirty: () => void;
  /** 切换编辑实体/表单重对齐:先补发仍在防抖窗口内的脏编辑(见文件头调用约定),再清态。 */
  reset: () => void;
  /** 删除当前实体前调用:丢弃待保存状态(绝不补发),并等待在飞保存收尾(见文件头)。 */
  discard: () => Promise<void>;
  /** 当前是否有未保存的编辑(重对齐 effect 用它守卫"外部值回填")。 */
  isDirty: () => boolean;
  /**
   * 立即保存(绕过防抖)。默认仅在脏时保存;force 时无条件保存(测试连接等
   * "确保服务端拿到当前草稿"的场景)。与在飞保存串行化。失败向调用方抛出。
   */
  saveNow: (options?: { force?: boolean }) => Promise<void>;
  /** 组件卸载:撤销定时器;仍有脏数据则尽力补发一次保存(错误走 onSaveError)。 */
  flushOnTeardown: () => void;
}

export function createAutosaveController(
  save: () => Promise<void>,
  options: AutosaveControllerOptions = {},
): AutosaveController {
  const delayMs = options.delayMs ?? 700;
  const scheduler: AutosaveScheduler = options.scheduler ?? {
    set: (fn, ms) => window.setTimeout(fn, ms),
    clear: (id) => window.clearTimeout(id),
  };

  let dirty = false;
  let saving = false;
  let editedDuringSave = false;
  let timer: number | null = null;
  let inFlight: Promise<void> | null = null;
  let status: AutosaveStatus = "idle";

  const setStatus = (next: AutosaveStatus) => {
    if (status === next) return;
    status = next;
    options.onStatusChange?.(next);
  };

  const clearTimer = () => {
    if (timer !== null) {
      scheduler.clear(timer);
      timer = null;
    }
  };

  const runSave = (): Promise<void> => {
    saving = true;
    editedDuringSave = false;
    setStatus("saving");
    const attempt = (async () => {
      try {
        await save();
        // 保存窗口内有编辑 → 保持脏并立即补排下一轮(这是三件套修复的核心)。
        dirty = editedDuringSave;
        if (dirty) schedule();
        else setStatus("saved");
      } catch (error) {
        dirty = true; // 失败保持脏:下一次编辑触发重试
        setStatus("failed");
        throw error;
      } finally {
        saving = false;
        inFlight = null;
      }
    })();
    inFlight = attempt;
    return attempt;
  };

  const schedule = () => {
    clearTimer();
    timer = scheduler.set(() => {
      timer = null;
      // 在飞保存尚未结束:跳过——完成回调看到 dirty 会自动补排。
      if (!dirty || saving) return;
      void runSave().catch((error) => options.onSaveError?.(error));
    }, delayMs);
  };

  return {
    markDirty() {
      dirty = true;
      if (saving) editedDuringSave = true;
      if (!saving) setStatus("pending");
      schedule();
    },
    reset() {
      clearTimer();
      // 切换实体丢弃待保存状态前,防抖窗口内(≤delayMs)的脏编辑先尽力补发——否则
      // "输入后 700ms 内点了另一个条目"会静默丢字。此刻 save 闭包仍指旧实体(见文件头
      // 调用约定)。已在飞的保存不重复发起:其完成回调会按 editedDuringSave 自行补排,
      // 但那时草稿已换新实体,属"编辑+切换同落在一个保存 RTT 内"的极端窗口,不在此兜。
      if (dirty && !saving) {
        void runSave().catch((error) => {
          options.onSaveError?.(error);
          // 补发失败是旧实体的遗憾,不能把脏标记留给新实体——否则调用方 isDirty 守卫
          // 会一直挡掉外部值回填。失败窗口内若新实体已有编辑(markDirty 已置
          // editedDuringSave 并排好定时器),则保持脏由其自行重试。
          dirty = editedDuringSave;
        });
      }
      dirty = false;
      editedDuringSave = false;
      // 切换实体后新表单尚未被编辑:状态归零,避免旧实体的 failed/saved 残影跟到新实体。
      if (!saving) setStatus("idle");
    },
    async discard() {
      clearTimer();
      dirty = false;
      editedDuringSave = false;
      // 等在飞保存收尾:调用方随后发 DELETE,若不等,这笔 POST 可能后到服务端复活实体。
      while (inFlight) {
        try {
          await inFlight;
        } catch {
          // 在飞那笔的错误已由其发起路径处理
        }
      }
      setStatus("idle");
    },
    isDirty: () => dirty,
    async saveNow({ force = false }: { force?: boolean } = {}) {
      clearTimer();
      // 串行化:等在飞保存收尾再决定是否补发,避免并发双写乱序。
      while (inFlight) {
        try {
          await inFlight;
        } catch {
          // 在飞那笔的错误已由其发起路径(防抖 onSaveError / 上一个 saveNow)处理
        }
      }
      if (!force && !dirty) return;
      await runSave();
    },
    flushOnTeardown() {
      clearTimer();
      if (dirty && !saving) {
        void runSave().catch((error) => options.onSaveError?.(error));
      }
    },
  };
}

/**
 * React 包装:save/onSaveError 每次渲染取最新闭包(草稿状态不需要额外 ref),
 * 卸载时自动 flushOnTeardown。
 *
 * 返回值在控制器之上多带一个响应式 `status`(AutosaveStatus),由 onStatusChange
 * 同步进 React state;配 `<AutosaveStatus/>` 渲染三态行(域7-1)。
 * `errorLabel`(分区名,如"MCP"/"世界书")仅用于缺省失败 toast 的文案定位;
 * 调用方传了 onSaveError 则完全接管失败呈现,缺省 toast 不再触发。
 */
export function useAutosaveDraft(
  save: () => Promise<void>,
  options?: Pick<AutosaveControllerOptions, "delayMs" | "onSaveError"> & {
    errorLabel?: string;
  },
): AutosaveController & { status: AutosaveStatus } {
  const saveRef = React.useRef(save);
  saveRef.current = save;
  const onSaveErrorRef = React.useRef(options?.onSaveError);
  onSaveErrorRef.current = options?.onSaveError;
  const errorLabelRef = React.useRef(options?.errorLabel);
  errorLabelRef.current = options?.errorLabel;
  const [status, setStatus] = React.useState<AutosaveStatus>("idle");
  const [controller] = React.useState(() =>
    createAutosaveController(() => saveRef.current(), {
      delayMs: options?.delayMs,
      onSaveError: (error) => {
        // 域7-1:缺省即外显——调用方未接管失败呈现时,统一 toast(分区名定位)。
        // 显式 onSaveError 优先(分区要自定义文案/附带动作时)。
        if (onSaveErrorRef.current) {
          onSaveErrorRef.current(error);
          return;
        }
        const label = errorLabelRef.current;
        const detail = error instanceof Error ? error.message : "";
        toast.error(
          label
            ? i18n.t("settings:common.autosave_failed_named", { name: label })
            : i18n.t("settings:common.autosave_failed"),
          detail ? { description: detail } : undefined,
        );
      },
      onStatusChange: setStatus,
    }),
  );
  React.useEffect(() => {
    return () => controller.flushOnTeardown();
  }, [controller]);
  return React.useMemo(() => Object.assign(controller, { status }), [controller, status]);
}
