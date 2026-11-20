// subprocess-engine/parent-watch.ts — 宿主进程里盯主程序的独立线程(P7.2.3,方案 §5.14.7「不留孤儿」第一层)
//
// 宿主进程的主线程盯着通道与 stdin,主程序没了就退出;但插件同步死循环时主线程被占住,那段代码跑不了,用户从任务管理器
// 结束应用后,宿主进程会留在后台占满一个核,还占着 exe 让更新失败。这里另开一条 Worker 线程,定时探主程序还在不在,
// 没了就结束整个进程。P7.1 实测(X7):Worker 里 process.exit 只结束那条线程,process.kill(自己的 pid, "SIGKILL")
// 才结束整个进程。探测遇 EPERM(进程在但无权限;杀毒软件会让它误报)连续 3 次才算主程序没了。
// pid 被系统复用给别的进程时这一层失效,另两层兜底:Windows 的作业对象(非 detached 启动)、主程序下次启动时的清扫。
// Worker 的代码经 blob 地址起(编译版里按文件路径起 Worker 要把文件列为额外入口):watchParent 的源码原样拼进 Worker,
// 所以它必须自成一体,不能引用外层的任何名字。

/** 每 intervalMs 探一次 parentPid,探不到就 kill(selfPid)。 */
export function watchParent(
  parentPid: number,
  selfPid: number,
  intervalMs: number,
  probe: (pid: number) => void,
  kill: (pid: number) => void,
): ReturnType<typeof setInterval> {
  let denied = 0;
  return setInterval(() => {
    try {
      probe(parentPid);
      denied = 0;
      return;
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "EPERM" && ++denied < 3) return;
    }
    kill(selfPid);
  }, intervalMs);
}

export const PARENT_WATCH_INTERVAL_MS = 500;

/** 在宿主进程里起盯主程序的线程;线程不拖住进程退出。 */
export function startParentWatchdog(parentPid: number = process.ppid, intervalMs: number = PARENT_WATCH_INTERVAL_MS): Worker {
  const source = `(${watchParent.toString()})(${parentPid}, ${process.pid}, ${intervalMs}, (pid) => process.kill(pid, 0), (pid) => process.kill(pid, "SIGKILL"));`;
  const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "application/javascript" })), { smol: true });
  // Bun 的 Worker 有 unref;界面库的 Worker 类型里没有
  (worker as Worker & { unref(): void }).unref();
  return worker;
}
