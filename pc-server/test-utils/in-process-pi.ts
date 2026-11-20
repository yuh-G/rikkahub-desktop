// test-utils/in-process-pi.ts — 测试里把注册表的 pi 驱动换成同进程的(P7.2.6)
//
// 生产的 pi 驱动跑在引擎宿主进程里(engines/index)。经生产装配跑工作区会话的测试(编排器、插件验收、插件页)
// 不起子进程:换成同进程的 pi 驱动,中间隔一层严格回环传输(每个载荷 JSON 往返,与跨进程同一份契约)。
// 调用方先设好 RIKKAHUB_PC_DATA_DIR 再 await import 本模块(它会加载 paths)。

import { replaceEngineDriverForTests } from "../engines/index";
import { appEngineHost } from "../engines/host";
import { connectDriver, connectHost, STRICT_CONTRACT_TRANSPORT } from "../engines/loopback";
import { createPiDriver } from "../pi-engine/driver";

/** 换上同进程的 pi 驱动;返回换回去的函数。 */
export function useInProcessPiDriver(): () => void {
  const strict = { strict: STRICT_CONTRACT_TRANSPORT };
  return replaceEngineDriverForTests(connectDriver(createPiDriver(connectHost(appEngineHost, strict)), strict));
}
