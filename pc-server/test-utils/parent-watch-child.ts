// test-utils/parent-watch-child.ts — 盯主程序那条线程的实跑替身(subprocess-engine/parent-watch.test.ts 用)
//   bun test-utils/parent-watch-child.ts <父进程 pid> <就绪标记文件>
// 起盯父进程的线程、写就绪标记,然后主线程进同步死循环(插件卡死主线程),只有那条线程能结束本进程。
import { writeFileSync } from "node:fs";

import { startParentWatchdog } from "../subprocess-engine/parent-watch";

startParentWatchdog(Number(Bun.argv[2]), 100);
writeFileSync(Bun.argv[3]!, String(process.pid));
for (;;);
