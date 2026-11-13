// pi-engine/agent-dir.ts — pi 数据目录接线(方案 §5.9 / P5.1)
//
// 我们调 pi 的 SDK 时都显式传 agentDir(runner / resources 传 piAgentDir),但插件和 pi 内部的一部分
// 代码直接调 getAgentDir(),它只认环境变量 PI_CODING_AGENT_DIR,缺省落到用户自己的 ~/.pi/agent。
// 驱动创建时把它指到应用的 pi 数据目录:进程内驱动随应用启动创建,子进程驱动在子进程入口创建(数据
// 目录经 RIKKAHUB_PC_DATA_DIR 传入),两处走同一个函数。用户环境里原有的值会被覆盖:插件不得读写
// 用户自己的 pi 配置。

import { ENV_AGENT_DIR } from "../../pi/packages/coding-agent/src/config.ts";
import { piAgentDir } from "../foundation/paths";

export function bindPiAgentDir(): void {
  process.env[ENV_AGENT_DIR] = piAgentDir;
}
