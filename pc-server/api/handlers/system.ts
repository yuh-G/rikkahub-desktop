// api/handlers/system.ts — 系统杂项路由（health/ai-icon/fonts、context-limit/prompt-optimize、logs/stats/sponsors）
// 纪律：纯搬迁自 server.ts routeApi()；辅助函数（字体/图标/统计等）暂经 ../../server 导入，待后续收敛。

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { customFontsDir, dataDir } from "../../foundation/paths";
import { saveState, state } from "../../persistence/json-store";
import { APP_VERSION } from "../../updates/index";
import { loadModelsDev, modelsDevCache } from "../../inference-engine/providers";
import { findModel } from "../../model-providers";
import { contextWindowFor } from "../../model-providers/model-limits";
import { error, json, readJson } from "../request";
import { isLoopbackRequest } from "../net-context";
import { appClients, mcpHealthSnapshotFrame, openSse } from "../sse";
import { memoryStore } from "../../memory/index";
import { recentAppErrors } from "../../observability/app-errors";
import { computeStats } from "../../conversations/stats";
import { DEFAULT_PROMPT_OPTIMIZE_PROMPT, PROMPT_OPTIMIZE_OUTPUT_TOKENS } from "../../app-config/prompts";
import { markUiActivity } from "../../app-config/analytics";
import { fetchAuxiliaryText } from "../../conversations/auxiliary";
import { serveAIIcon } from "../../assets/icons";
import { FONT_EXTENSIONS_SET, FONT_MIME, MAX_FONT_BYTES, fontCssName, fontExtension, isBareFileName, isFontFile, listBuiltinFonts, listCustomFonts, listSystemFonts, makeBundledFontEntry, resolveFontFile } from "../../assets/fonts";

export async function handleSystemRoutes(request: Request, url: URL, path: string): Promise<Response | null> {
  // 4-6:不回显绝对 dataDir 路径(未鉴权即可见的轻微信息泄露;无消费方读它)。
  if (path === "health") return json({ ok: true, version: APP_VERSION });
  // 专题6:UI 活动信标——前端在窗口可见且聚焦时定期上报,analytics 据此把"使用
  // 时长"心跳限定在用户实际在用的时间段(托盘常驻/无头部署不再灌时长)。
  if (path === "activity" && request.method === "POST") {
    // C3:信标携带自上一拍以来的真实聚焦毫秒数(前端权威计量),后端钳制累加。
    // 信标是 fire-and-forget 统计信号,畸形 body 按 0 处理,永不报错。
    const body = await readJson<{ ms?: number }>(request).catch(() => ({}) as { ms?: number });
    markUiActivity(Number(body?.ms ?? 0));
    return json({ ok: true });
  }
  // 单一应用事件通道(连接预算纪律,详见 api/sse.ts 顶部注释):设置/记忆/错误/列表失效
  // 四域合一。连接即推各域完整快照——重连本身就是状态补偿,客户端无需另发 GET。
  if (path === "events") {
    return openSse(
      () => [
        ["settings", state.settings],
        ["memory", memoryStore.getSnapshot()],
        ["app_errors_snapshot", { type: "snapshot", errors: recentAppErrors() }],
        ["invalidate", { type: "invalidate", assistantId: state.settings.assistantId, timestamp: Date.now() }],
        mcpHealthSnapshotFrame(),
      ],
      (controller) => {
        appClients.add(controller);
        return () => appClients.delete(controller);
      },
    );
  }
  // 代码块"在浏览器中打开"(桌面壳专用):WebView2 吞掉 window.open(blob:),blob URL
  // 也只在页面内有效。落盘为临时文件后交给系统默认程序(.html → 默认浏览器)。
  // 文件放 dataDir/tmp 下,file:// 页面与应用源完全隔离,不触及应用的 localStorage。
  if (path === "code-preview/open" && request.method === "POST") {
    const body = await readJson<{ content?: string; language?: string }>(request);
    const content = typeof body?.content === "string" ? body.content : "";
    if (!content) return error("Missing content", 400);
    const normalized = String(body?.language ?? "").trim().toLowerCase();
    const ext = normalized === "html" || normalized === "htm" ? "html" : normalized === "svg" ? "svg" : "txt";
    const previewDir = join(dataDir, "tmp", "code-preview");
    mkdirSync(previewDir, { recursive: true });
    // 顺手清理 1 小时前的旧预览文件,目录不随使用无限膨胀。
    const expireBefore = Date.now() - 60 * 60 * 1000;
    for (const name of readdirSync(previewDir)) {
      const stale = join(previewDir, name);
      try {
        if (statSync(stale).mtimeMs < expireBefore) rmSync(stale, { force: true });
      } catch {
        // 竞态删除失败无关紧要,下次再清
      }
    }
    const file = join(previewDir, `code-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    await Bun.write(file, content);
    const opener =
      process.platform === "win32"
        ? ["cmd", "/c", "start", "", file]
        : process.platform === "darwin"
          ? ["open", file]
          : ["xdg-open", file];
    Bun.spawn(opener, { stdout: "ignore", stderr: "ignore" });
    return json({ ok: true });
  }
  // 域10-1(交互审查 4A):分享导出落盘 + 在文件夹中定位。
  // 桌面壳(与后端同机)把导出内容写进 dataDir/exports/,toast 携带"在文件夹中显示"按钮,
  // 点按调 reveal 用系统文件管理器选中该文件。仅限本机直连(与 data/export/to-path 同一回环闸);
  // 浏览器部署维持原下载通道,不走这里。
  if (path === "exports/save" && request.method === "POST") {
    if (!isLoopbackRequest(request)) return error("Forbidden: this endpoint is loopback-only", 403);
    const body = await readJson<{ content?: string; filename?: string; encoding?: string }>(request);
    const content = typeof body?.content === "string" ? body.content : "";
    if (!content) return error("Missing content", 400);
    // 文件名白名单化:剥离任何路径前缀,只留安全 basename,防 traversal。
    const safeName = (typeof body?.filename === "string" ? body.filename : "")
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "");
    if (!safeName) return error("Invalid filename", 400);
    const isBase64 = body?.encoding === "base64";
    const exportsDir = join(dataDir, "exports");
    mkdirSync(exportsDir, { recursive: true });
    // 同名冲突时追加序号,不覆盖旧导出。
    let file = join(exportsDir, safeName);
    const dot = safeName.lastIndexOf(".");
    const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
    const ext = dot > 0 ? safeName.slice(dot) : "";
    for (let i = 1; existsSync(file); i++) file = join(exportsDir, `${stem} (${i})${ext}`);
    await Bun.write(file, isBase64 ? Buffer.from(content, "base64") : content);
    return json({ ok: true, path: file, filename: basename(file) });
  }
  if (path === "exports/reveal" && request.method === "POST") {
    if (!isLoopbackRequest(request)) return error("Forbidden: this endpoint is loopback-only", 403);
    const body = await readJson<{ path?: unknown }>(request);
    const target = typeof body?.path === "string" ? body.path : "";
    // 只允许定位 dataDir/exports/ 内的文件,不暴露任意路径给系统 shell。
    const exportsDir = join(dataDir, "exports");
    if (!target.startsWith(exportsDir) || !existsSync(target)) return error("Invalid path", 400);
    const opener =
      process.platform === "win32"
        ? ["explorer", "/select,", target]
        : process.platform === "darwin"
          ? ["open", "-R", target]
          : ["xdg-open", exportsDir];
    Bun.spawn(opener, { stdout: "ignore", stderr: "ignore" });
    return json({ ok: true });
  }
  if (path === "ai-icon" && request.method === "GET") {
    const name = url.searchParams.get("name")?.trim();
    if (!name) return error("Missing name", 400);
    return serveAIIcon(name);
  }
  // 字体目录:三层来源一起返回,前端拼下拉框 + 注入 @font-face。
  // 系统/自定义字体去重:与 builtin 同名(cssName)的系统字体不返回,避免重复显示。
  if (path === "fonts/list" && request.method === "GET") {
    const builtin = listBuiltinFonts();
    const custom = listCustomFonts();
    const exclude = new Set<string>();
    for (const entry of [...builtin, ...custom]) exclude.add(entry.cssName.toLowerCase());
    const system = listSystemFonts(exclude);
    return json({ builtin, custom, system });
  }
  const fontServe = path.match(/^fonts\/(builtin|custom)\/(.+)$/);
  if (fontServe && request.method === "GET") {
    const source = fontServe[1] as "builtin" | "custom";
    let fileName: string;
    try { fileName = decodeURIComponent(fontServe[2]); }
    catch { return error("Invalid font name", 400); }
    const target = resolveFontFile(source, fileName);
    if (!target) return error("Font not found", 404);
    return new Response(Bun.file(target), {
      headers: {
        "Content-Type": FONT_MIME[fontExtension(fileName)] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }
  if (path === "fonts/upload" && request.method === "POST") {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return error("Missing file", 400);
    const ext = fontExtension(file.name);
    if (!FONT_EXTENSIONS_SET.has(ext)) return error("Unsupported font format (use ttf/otf/woff/woff2)", 400);
    if (file.size > MAX_FONT_BYTES) return error(`Font too large (max ${MAX_FONT_BYTES / 1024 / 1024}MB)`, 413);
    // sanitize:只保留文件名部分,去掉任何路径前缀,防 traversal。
    const rawName = fontCssName(file.name) + ext;
    const safeName = rawName.replace(/[\\/\u0000]/g, "_");
    if (!isBareFileName(safeName) || safeName === "." || safeName === "..") return error("Invalid filename", 400);
    mkdirSync(customFontsDir, { recursive: true });
    const target = join(customFontsDir, safeName);
    await Bun.write(target, file);
    console.log(`[fonts] uploaded ${safeName} (${(file.size / 1024).toFixed(1)} KB)`);
    return json({ font: makeBundledFontEntry("custom", safeName) });
  }
  const fontDelete = path.match(/^fonts\/custom\/(.+)$/);
  if (fontDelete && request.method === "DELETE") {
    let fileName: string;
    try { fileName = decodeURIComponent(fontDelete[1]); }
    catch { return error("Invalid font name", 400); }
    if (!isBareFileName(fileName) || !isFontFile(fileName)) return error("Invalid font name", 400);
    const target = join(customFontsDir, fileName);
    if (!existsSync(target)) return error("Font not found", 404);
    rmSync(target, { force: true });
    console.log(`[fonts] deleted ${fileName}`);
    return json({ status: "deleted" });
  }
  if (path === "context-limit" && request.method === "GET") {
    // 查询某模型的 context window 上限(来自 models.dev)。前端切换当前模型时调用,
    // 让统计行分母跟随"当前选中模型"而非"生成时模型"。匹配不到返回 null。
    // modelId 收我们的模型 id(UUID 优先,findModel 也接上游 modelId):目录查表按
    // **端点身份**(baseUrl 主机)取值,provider 必须由 findModel 解析——它会展开
    // providerOverwrite,故按模型覆写走别家网关的模型也能查对。
    const mid = url.searchParams.get("modelId");
    if (!mid) return json({ contextLimit: null });
    // 首次启动时前端可能赶在 models.dev 加载完之前发请求。await 一下:已加载则立即返回
    // (常态),还在加载则等它完(loadModelsDev 内部有 10s fetch timeout 兜底)。这样 null 的
    // 语义是确定的"models.dev 里查不到此模型",前端可以安全缓存,不会把启动期的临时空
    // 缓存永久当真。loadModelsDev 对并发调用做了去重,多个请求共用同一个 in-flight promise。
    await loadModelsDev();
    if (!modelsDevCache) return json({ contextLimit: null });
    const found = findModel(mid);
    return json({ contextLimit: contextWindowFor(modelsDevCache, found.provider, found.model.modelId) });
  }
  if (path === "prompt/optimize" && request.method === "POST") {
    // 用户在对话输入框点"优化提示词":把原文(+可选的最近几轮对话上下文)+ meta-prompt
    // 发给"提示词优化模型",返回优化后的文本由前端直接替换输入框内容。
    // 上下文让优化模型能理解"那个""上次的"等指代——首条消息或无对话时省略。
    // 未配置模型时返回 400,前端引导去设置页。
    const body = await readJson<{ text: string; context?: string }>(request);
    const text = String(body.text ?? "").trim();
    if (!text) return error("没有可优化的文本", 400);
    const modelId = state.settings.promptOptimizeModelId;
    if (!modelId) {
      return error("未配置提示词优化模型,请在「设置 - 默认模型与提示词」中指定一个模型", 400);
    }
    const context = String(body.context ?? "").trim();
    let prompt = String(state.settings.promptOptimizePrompt ?? "").trim() || DEFAULT_PROMPT_OPTIMIZE_PROMPT;
    if (context) {
      // 条件式上下文:明确告诉模型"只在提示词承接对话时才用,否则忽略",防止无关背景
      // 污染独立提示词。同时禁止把背景内容写进优化结果(防止泄漏/跑题)。
      prompt += `\n\n## 对话背景(仅供理解,不要优化这部分,也不要把它的内容写进结果)\n\n下面是用户与 AI 之前的几轮对话。只有当待优化的提示词明显是在承接这段对话时(出现"那个""上面说的""再…一下"等指代),你才用它来理解用户指的是什么,从而让优化后的表达更明确。如果提示词本身独立、完整,或和这段对话无关,就忽略这段背景,把它当成全新请求来优化。\n\n<对话背景>\n${context}\n</对话背景>`;
    }
    prompt += `\n\n请优化以下提示词,直接输出优化后的版本:\n\n<original_prompt>\n${text}\n</original_prompt>`;
    try {
      // temperature 0.5:既要能找到更好的措辞,又不能偏离原意乱发挥。
      // 输出预算 PROMPT_OPTIMIZE_OUTPUT_TOKENS:优化结果可能比原文长(结构化展开),给足
      // 余量避免截断;这是我们给任务定的数,fetchAuxiliaryText 会经 internalOutputCap
      // 收进模型真实上限(见 model-limits 头注)。
      // reasoningLevel 不设(用模型默认,跟上下文压缩一致)——提示词优化是重写润色,不是推理任务。
      const optimized = await fetchAuxiliaryText(modelId, prompt, "prompt-optimize", {
        maxTokens: PROMPT_OPTIMIZE_OUTPUT_TOKENS,
        temperature: 0.5,
      });
      return json({ text: optimized });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "logs" && request.method === "GET") return json(state.logs);
  if (path === "logs" && request.method === "DELETE") {
    state.logs = [];
    saveState();
    return json({ ok: true });
  }
  if (path === "stats" && request.method === "GET") return json(await computeStats());
  // ── 赞助者列表(预留接口,待接入数据源)──────────────────────────
  // 前端 DonateSection 暂未展示该列表;数据源就绪后在此返回即自动渲染。
  // 方案(零服务器):GitHub Actions 定时调爱发电 query-order API
  // (user_id + token 的 md5 签名鉴权)分页拉订单 → 按赞助者聚合成下方结构 →
  // 发布为公开静态 JSON(GitHub Pages / jsDelivr)→ 此处 fetch 并返回(建议加短时缓存)。
  // token 必须保密(放 Actions Secret,切勿入库)。返回结构须与前端 Sponsor 类型一致:
  //   { userName: string, avatar: string, amount?: string }
  if (path === "sponsors" && request.method === "GET") return json([]);
  return null;
}
