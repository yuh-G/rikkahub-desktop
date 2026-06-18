import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import api, { appendWebAuthQuery } from "~/services/api";
import { cn } from "~/lib/utils";

export type UpdateInfo = {
  current: string;
  latest: string;
  isNewer: boolean;
  isSkipped?: boolean;
  title: string;
  notes: string;
  htmlUrl: string;
  downloadUrl: string;
  fileName: string;
  size: number;
  cachedInstallerPath?: string | null;
  /** 运行平台，决定走哪种更新应用流程（win→NSIS 安装器，linux→二进制替换）。 */
  platform?: "win" | "mac" | "linux";
  /** 容器化部署（Docker 等）无法原地更新，前端改为提示 docker pull。 */
  containerized?: boolean;
};

interface UpdateDialogProps {
  info: UpdateInfo;
  open: boolean;
  onClose: () => void;
}

export function UpdateDialog({ info, open, onClose }: UpdateDialogProps) {
  const [downloading, setDownloading] = React.useState(false);
  const [downloadProgress, setDownloadProgress] = React.useState(0);
  const [downloadedBytes, setDownloadedBytes] = React.useState(0);
  const [totalBytes, setTotalBytes] = React.useState(0);
  const [installerPath, setInstallerPath] = React.useState<string | null>(
    info.cachedInstallerPath ?? null,
  );
  const [installerCached, setInstallerCached] = React.useState(!!info.cachedInstallerPath);
  const [installerLaunching, setInstallerLaunching] = React.useState(false);

  const handleClose = () => {
    onClose();
    // Reset download state so next open is clean
    setDownloading(false);
    setDownloadProgress(0);
    setDownloadedBytes(0);
    setTotalBytes(0);
  };

  const skipThisVersion = async () => {
    try {
      await api.post("update/skip", { version: info.latest });
      toast.success(`已忽略 ${info.latest} 的更新提醒`);
    } catch {
      toast.error("操作失败");
    }
    onClose();
  };

  const downloadAndInstall = async () => {
    if (!info.downloadUrl) return;
    setDownloading(true);
    setDownloadProgress(0);
    setDownloadedBytes(0);
    setTotalBytes(0);
    try {
      // 后端用 text/event-stream 流式推 {type:"progress"|"done"|"error"}。fetch + ReadableStream
      // 解析每个事件实时更新进度条——之前 XHR 监听响应进度,但后端 arrayBuffer 下完才返回,
      // 下载期间一个字节都不吐,进度条自然不动。
      const res = await fetch(appendWebAuthQuery("/api/update/download"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: info.downloadUrl, fileName: info.fileName }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const result = { path: "", size: 0, done: false };
      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) return;
        let evt: { type?: string; loaded?: number; total?: number; percent?: number; path?: string; size?: number; message?: string };
        try {
          evt = JSON.parse(trimmed.slice(6));
        } catch {
          return;
        }
        if (evt.type === "progress") {
          setTotalBytes(Number(evt.total) || 0);
          setDownloadedBytes(Number(evt.loaded) || 0);
          setDownloadProgress(Number(evt.percent) || 0);
        } else if (evt.type === "done") {
          result.path = String(evt.path ?? "");
          result.size = Number(evt.size) || 0;
          result.done = true;
        } else if (evt.type === "error") {
          throw new Error(String(evt.message || "下载失败"));
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      }
      if (buffer.trim()) handleLine(buffer);
      if (!result.done) throw new Error("下载未完成");
      setInstallerPath(result.path);
      setInstallerCached(false);
      setDownloadProgress(100);
      toast.success("更新包下载完成");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "下载失败");
    } finally {
      setDownloading(false);
    }
  };

  // Windows only: hand the downloaded installer to the Tauri shell, which launches it as a
  // detached NSIS process and then we exit so the installer's "close target app" check passes.
  const launchAndExit = async () => {
    if (!installerPath) return;
    setInstallerLaunching(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("launch_installer", { path: installerPath });
      toast.success("安装程序已启动，应用即将退出");
      await new Promise((resolve) => setTimeout(resolve, 800));
      const { exit } = await import("@tauri-apps/plugin-process");
      await exit(0);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : "启动安装程序失败";
      toast.error(`启动安装程序失败：${message}`);
      setInstallerLaunching(false);
    }
  };

  // Linux: the binary was downloaded + chmod'd by the backend. Ask it to atomically swap
  // process.execPath for the new file. The running process keeps serving on the old inode
  // until it exits, so the call returns cleanly; the user then restarts to run the new version.
  const applyUpdate = async () => {
    if (!installerPath) return;
    setInstallerLaunching(true);
    try {
      await api.post("update/apply", { path: installerPath });
      toast.success("更新已应用，请重启 Rikkahub 生效");
      handleClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "应用更新失败";
      toast.error(message);
      setInstallerLaunching(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) handleClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{info.isNewer ? "发现新版本" : "当前已是最新版本"}</DialogTitle>
          <DialogDescription>
            {info.isNewer
              ? `当前版本 ${info.current} → 最新版本 ${info.latest}`
              : `当前 ${info.current}，已是最新（${info.latest || "未知"}）。`}
          </DialogDescription>
        </DialogHeader>
        {info.notes ? (
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">更新说明</div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
              {info.notes}
            </pre>
          </div>
        ) : null}
        {info.containerized ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
            检测到容器化部署，无法在应用内自动更新。请运行
            <code className="mx-0.5 rounded bg-amber-500/10 px-1 py-0.5 font-mono">
              docker pull
            </code>
            拉取最新镜像后重建容器。
          </div>
        ) : null}
        {downloading ? (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{downloadProgress > 0 ? `正在更新 · ${downloadProgress}%` : "正在更新…"}</span>
              {totalBytes > 0 ? (
                <span className="font-mono">
                  {(downloadedBytes / (1024 * 1024)).toFixed(1)} /{" "}
                  {(totalBytes / (1024 * 1024)).toFixed(1)} MB
                </span>
              ) : downloadedBytes > 0 ? (
                <span className="font-mono">{(downloadedBytes / (1024 * 1024)).toFixed(1)} MB</span>
              ) : null}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full bg-primary transition-all",
                  downloadProgress === 0 && "w-full animate-pulse",
                )}
                style={downloadProgress > 0 ? { width: `${downloadProgress}%` } : undefined}
              />
            </div>
          </div>
        ) : null}
        {installerPath ? (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-300">
            {info.platform === "linux" ? (
              <>
                ✅ 新版本已下载就绪（含二进制与前端）。点击下方按钮应用更新，应用后需手动重启
                Rikkahub 生效。数据目录与配置不受影响。
              </>
            ) : (
              <>
                {installerCached
                  ? "✅ 更新包已就绪："
                  : "更新包已下载完成，点击下方按钮重启并更新："}
                <code className="ml-1 break-all font-mono">{installerPath}</code>
                <br />
                安装过程会自动保留你的数据目录和配置。
              </>
            )}
          </div>
        ) : null}
        <DialogFooter>
          {!info.isNewer ? (
            <Button type="button" onClick={handleClose}>
              我知道了
            </Button>
          ) : info.containerized ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="mr-auto"
                onClick={() => void skipThisVersion()}
              >
                忽略此版本
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => info.htmlUrl && window.open(info.htmlUrl, "_blank")}
              >
                查看 Release
              </Button>
              <Button type="button" onClick={handleClose}>
                稍后再说
              </Button>
            </>
          ) : !info.downloadUrl ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="mr-auto"
                onClick={() => void skipThisVersion()}
              >
                忽略此版本
              </Button>
              <Button
                type="button"
                onClick={() => info.htmlUrl && window.open(info.htmlUrl, "_blank")}
              >
                前往 GitHub 下载
              </Button>
            </>
          ) : !installerPath ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="mr-auto"
                onClick={() => void skipThisVersion()}
                disabled={downloading}
              >
                忽略此版本
              </Button>
              <Button type="button" variant="outline" onClick={handleClose} disabled={downloading}>
                稍后再说
              </Button>
              <Button
                type="button"
                onClick={() => void downloadAndInstall()}
                disabled={downloading || !info.downloadUrl}
              >
                {downloading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Download className="size-4" />
                )}
                {downloading ? "正在更新…" : "立即更新"}
              </Button>
            </>
          ) : info.platform === "linux" ? (
            <>
              <Button type="button" variant="outline" onClick={handleClose}>
                稍后重启
              </Button>
              <Button
                type="button"
                onClick={() => void applyUpdate()}
                disabled={installerLaunching}
              >
                {installerLaunching ? <Loader2 className="size-4 animate-spin" /> : null}
                应用并重启
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={handleClose}>
                稍后再更新
              </Button>
              <Button
                type="button"
                onClick={() => void launchAndExit()}
                disabled={installerLaunching}
              >
                {installerLaunching ? <Loader2 className="size-4 animate-spin" /> : null}
                重启并更新
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
