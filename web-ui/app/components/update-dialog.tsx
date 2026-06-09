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
import { appendWebAuthQuery } from "~/services/api";
import { cn } from "~/lib/utils";

export type UpdateInfo = {
  current: string;
  latest: string;
  isNewer: boolean;
  title: string;
  notes: string;
  htmlUrl: string;
  downloadUrl: string;
  fileName: string;
  size: number;
  cachedInstallerPath?: string | null;
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
  const [installerPath, setInstallerPath] = React.useState<string | null>(info.cachedInstallerPath ?? null);
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

  const downloadAndInstall = async () => {
    if (!info.downloadUrl) return;
    setDownloading(true);
    setDownloadProgress(0);
    setDownloadedBytes(0);
    setTotalBytes(0);
    try {
      const result = await new Promise<{ status: string; path: string; size: number }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", appendWebAuthQuery("/api/update/download"));
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.responseType = "json";
        xhr.timeout = 0;
        xhr.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) {
            setTotalBytes(event.total);
            setDownloadedBytes(event.loaded);
            setDownloadProgress(Math.round((event.loaded / event.total) * 100));
          } else {
            setDownloadedBytes(event.loaded);
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
            resolve(xhr.response as { status: string; path: string; size: number });
          } else {
            reject(new Error(typeof xhr.response?.error === "string" ? xhr.response.error : `HTTP ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error("网络错误，无法连接后端"));
        xhr.ontimeout = () => reject(new Error("下载超时"));
        xhr.send(JSON.stringify({ url: info.downloadUrl, fileName: info.fileName }));
      });
      setInstallerPath(result.path);
      setInstallerCached(false);
      setDownloadProgress(100);
      toast.success("下载完成，准备启动安装");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "下载失败");
    } finally {
      setDownloading(false);
    }
  };

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
      const message = err instanceof Error ? err.message : (typeof err === "string" ? err : "启动安装程序失败");
      toast.error(`启动安装程序失败：${message}`);
      setInstallerLaunching(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {info.isNewer ? "发现新版本" : "当前已是最新版本"}
          </DialogTitle>
          <DialogDescription>
            {info.isNewer
              ? `当前版本 ${info.current} → 最新版本 ${info.latest}`
              : `当前 ${info.current}，已是最新（${info.latest || "未知"}）。`}
          </DialogDescription>
        </DialogHeader>
        {info.notes ? (
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">更新说明</div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{info.notes}</pre>
          </div>
        ) : null}
        {downloading ? (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{downloadProgress > 0 ? `下载中 · ${downloadProgress}%` : "下载中…"}</span>
              {totalBytes > 0 ? (
                <span className="font-mono">
                  {(downloadedBytes / (1024 * 1024)).toFixed(1)} / {(totalBytes / (1024 * 1024)).toFixed(1)} MB
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
            {installerCached ? "✅ 上次已下载，可直接安装：" : "安装包已下载到本地："}
            <code className="ml-1 break-all font-mono">{installerPath}</code>
            <br />
            点击下方"启动安装并退出"会启动 NSIS 安装程序并自动退出 Rikkahub，安装过程会保留你的数据目录和配置。
          </div>
        ) : null}
        <DialogFooter>
          {!info.isNewer ? (
            <Button type="button" onClick={handleClose}>
              我知道了
            </Button>
          ) : !installerPath ? (
            <>
              <Button type="button" variant="outline" onClick={handleClose} disabled={downloading}>
                稍后再说
              </Button>
              <Button type="button" onClick={() => void downloadAndInstall()} disabled={downloading || !info.downloadUrl}>
                {downloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                {downloading ? "下载中…" : "下载安装包"}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={handleClose}>
                稍后再安装
              </Button>
              <Button type="button" onClick={() => void launchAndExit()} disabled={installerLaunching}>
                {installerLaunching ? <Loader2 className="size-4 animate-spin" /> : null}
                启动安装并退出
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
