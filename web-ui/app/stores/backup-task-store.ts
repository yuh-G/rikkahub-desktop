// 数据管理 › 备份与恢复的长任务状态(本地导出/导入、WebDAV/S3 备份/恢复/列表)。放在模块级
// 而非组件 state:任务进行中用户切到「Web 服务」或关掉设置,页面卸载但请求照常跑完;重新进入时
// 进度与禁用态必须还在,否则按钮重新可点,用户能在后端尚未结束时再发起一次导入或恢复(后端无
// 互斥),浏览器导出还会再攒一个大 Blob。只在内存,不持久化。
import { create } from "zustand";

export interface RemoteBackupItem {
  href: string;
  displayName: string;
  size: number;
  lastModified: string;
}

export interface BackupProgress {
  message: string;
  percent: number;
}

export type ImportPhase = "idle" | "uploading" | "processing";

export type RemoteKind = "webdav" | "s3";

export interface RemoteTaskState {
  /** 进行中的操作:"" 空闲,否则 "list" | "test" | "backup" | "restore:<名>" | "delete:<名>"。 */
  busy: string;
  progress: BackupProgress | null;
  items: RemoteBackupItem[];
}

interface BackupTaskState {
  exporting: boolean;
  /** 已下载 / 总字节;总数未知时为 0(构建阶段无字节进度)。 */
  exportLoaded: number;
  exportTotal: number;
  importing: boolean;
  importPhase: ImportPhase;
  importProgress: number;
  remote: Record<RemoteKind, RemoteTaskState>;
}

const IDLE_REMOTE: RemoteTaskState = { busy: "", progress: null, items: [] };

export const useBackupTaskStore = create<BackupTaskState>(() => ({
  exporting: false,
  exportLoaded: 0,
  exportTotal: 0,
  importing: false,
  importPhase: "idle",
  importProgress: 0,
  remote: { webdav: IDLE_REMOTE, s3: IDLE_REMOTE },
}));

export function patchBackupTask(patch: Partial<Omit<BackupTaskState, "remote">>): void {
  useBackupTaskStore.setState(patch);
}

export function patchRemoteTask(kind: RemoteKind, patch: Partial<RemoteTaskState>): void {
  useBackupTaskStore.setState((state) => ({
    remote: { ...state.remote, [kind]: { ...state.remote[kind], ...patch } },
  }));
}
