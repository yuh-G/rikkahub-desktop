// foundation/platform.ts — 运行时平台检测
// 纪律：只导出平台相关常量和函数，不依赖业务逻辑，不引入副作用。

import { existsSync } from "node:fs";
import { dataDir } from "./paths";

export function tempDir(): string {
  const t = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
  if (t) return t;
  return process.platform === "win32" ? dataDir : "/tmp";
}

export function osType(): string {
  if (process.platform === "linux") return "Linux";
  if (process.platform === "darwin") return "macOS";
  return "Windows";
}

// 运行平台（用于自动更新：Windows 走 Tauri NSIS 安装器，Linux 走二进制原地替换）。
// 与 analyticsOs() 的划分保持一致 —— Docker 容器内 process.platform 也是 "linux"，
// 这是对的：Docker 镜像就是 Linux 二进制，只是它的更新路径不同（见下）。
export const RUNTIME_PLATFORM: "win" | "mac" | "linux" =
  process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : "win";

// 容器化部署检测。Docker 内即使替换了 /app/rikkahub-pc，容器一旦重建就会回到镜像里的
// 旧版本，原地更新没有意义 —— 这类部署应当 docker pull 新镜像。检测 /.dockerenv（Docker
// 标准标记）或显式注入的环境变量（兼容其他容器运行时）。
export const RUNNING_IN_CONTAINER = existsSync("/.dockerenv") || process.env.RIKKAHUB_CONTAINER === "1";

// ── 桌面壳生命周期守护(Linux)──────────────────────────────────────────
// Windows 侧由 Tauri 壳用 Job Object 保证"壳退出即回收 sidecar";Linux 没有等价的内核
// 机制,壳被强杀/崩溃后 sidecar 会变成孤儿进程,继续占住端口和数据目录。Tauri 壳启动
// sidecar 时注入 RIKKAHUB_PARENT_PID(壳自身 PID),这里周期性探测:父进程消失就自行退出
// (normal 退出走壳的 /api/app/shutdown 优雅停机,本守护只管"壳死了"的兜底)。
// 只在变量存在时启用——独立二进制(直接运行 rikkahub-app/rikkahub-server)和 Docker 不
// 设置,行为与之前完全一致;Windows 不启用(Job Object 已覆盖,且 kill(pid, 0) 语义不同)。
//
// 退出方式:向自身发 SIGTERM 而非直接 process.exit(0)——server.ts 尾部注册的 SIGTERM
// 处理器会走完整刷盘链(saveState/flushSaveState/flushConvDirtyNow/reconcile/checkpoint),
// 壳被强杀时最多丢 throttle 窗口内的增量,而不是把整个 state 写丢了。模块纪律不受影响:
// 这里不 import 任何业务逻辑,刷盘由 server 自己的信号路径完成。
export function startParentWatchdogIfRequested(): void {
  const parentShellPid = Number(process.env.RIKKAHUB_PARENT_PID || 0);
  if (parentShellPid <= 0 || process.platform === "win32") return;
  const parentWatchdog = setInterval(() => {
    try {
      process.kill(parentShellPid, 0);
    } catch (watchErr) {
      // 只有 ESRCH(进程不存在)才退出;EPERM 等其他错误说明进程还在,只是权限受限。
      const code =
        typeof watchErr === "object" && watchErr !== null && "code" in watchErr
          ? String(watchErr.code)
          : "";
      if (code !== "ESRCH") return;
      console.log("[sidecar] parent shell exited, shutting down");
      clearInterval(parentWatchdog);
      process.kill(process.pid, "SIGTERM");
    }
  }, 2000);
}
