// engines/host.ts — EngineHost 的应用侧实现(P2.3 收齐;目前只有错误上报出口)
//
// 引擎经 host.report 把诊断交给应用的错误中心,不直接 import observability。

import { reportError } from "../observability/app-errors";
import type { EngineErrorReport } from "./contract";

export function reportEngineError(report: EngineErrorReport): void {
  reportError(report.domain, report.severity, report.message, report.detail, report.code, report.params);
}
