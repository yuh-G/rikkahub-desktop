// api/handlers/data.ts — 数据备份路由（data/webdav/*、data/s3/*、data/export|import|register-schema）
// 纪律：纯搬迁自 server.ts routeApi()；备份 zip 结构与 Android 互导契约冻结。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Database } from "bun:sqlite";
import type { S3Config, State, WebDavConfig } from "../../foundation/types";
import { dataDir } from "../../foundation/paths";
import { isWindowsReservedName } from "../../foundation/windows-names";
import { tempDir } from "../../foundation/platform";
import { friendlyRequestError } from "../../foundation/net";
import { state } from "../../persistence/json-store";
import { getConversationsDb } from "../../conversations";
import { countConversations } from "../../conversations/read-queries";
import { createSettingsBackupZipToPath } from "../../backup/export";
import { applyAndroidZipBackupFromPath, applyBackupPayload, buildImportWarnings, customJsImportWarning, customJsScriptSignatures } from "../../backup/import";
import { normalizeS3Config, normalizeWebDavConfig } from "../../app-config/backup-config";
import {
  s3Backup,
  s3Delete,
  s3ListBackups,
  s3Restore,
  s3TestConnection,
  webDavBackup,
  webDavDelete,
  webDavEnsureCollection,
  webDavListBackups,
  webDavRestore,
} from "../../backup/storage";
import { error, json, readJson, sseHeaders } from "../request";
import { isLoopbackRequest } from "../net-context";
import { sseFrame } from "../sse";
import { updateSettings } from "../../app-config";

export async function handleDataRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
  if (path === "data/webdav/config" && request.method === "POST") {
    const body = await readJson<Partial<WebDavConfig>>(request);
    const webDavConfig = normalizeWebDavConfig(body);
    updateSettings({ ...state.settings, webDavConfig });
    return json({ status: "ok", config: webDavConfig });
  }
  if (path === "data/webdav/test" && request.method === "POST") {
    const config = normalizeWebDavConfig((await readJson<{ config?: Partial<WebDavConfig> }>(request)).config ?? state.settings.webDavConfig);
    try {
      await webDavEnsureCollection(config);
      return json({ status: "ok" });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/webdav/list" && request.method === "GET") {
    try {
      return json({ items: await webDavListBackups(state.settings.webDavConfig) });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/webdav/backup" && request.method === "POST") {
    try {
      const result = await webDavBackup(state.settings.webDavConfig);
      return json({ status: "ok", ...result, items: await webDavListBackups(state.settings.webDavConfig) });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/webdav/restore" && request.method === "POST") {
    const body = await readJson<{ fileName?: string }>(request);
    const fileName = String(body.fileName ?? "").trim();
    if (!fileName || fileName.includes("/") || fileName.includes("\\")) return error("Invalid WebDAV backup file name", 400);
    try {
      await webDavRestore(state.settings.webDavConfig, fileName);
      return json({ status: "restored", settings: state.settings });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/webdav/delete" && request.method === "POST") {
    const body = await readJson<{ fileName?: string }>(request);
    const fileName = String(body.fileName ?? "").trim();
    if (!fileName || fileName.includes("/") || fileName.includes("\\")) return error("Invalid WebDAV backup file name", 400);
    try {
      await webDavDelete(state.settings.webDavConfig, fileName);
      return json({ status: "deleted", items: await webDavListBackups(state.settings.webDavConfig) });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/webdav/backup/stream" && request.method === "POST") {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, payload: Record<string, unknown>) => controller.enqueue(sseFrame(event, payload));
        try {
          const result = await webDavBackup(state.settings.webDavConfig, (message, percent) => {
            send("progress", { message, percent: percent ?? 0 });
          });
          const items = await webDavListBackups(state.settings.webDavConfig);
          send("done", { status: "ok", fileName: result.fileName, size: result.size, items });
        } catch (err) {
          send("error", { error: friendlyRequestError(err, state.settings.proxyConfig) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: sseHeaders() });
  }
  if (path === "data/webdav/restore/stream" && request.method === "POST") {
    const body = await readJson<{ fileName?: string }>(request);
    const fileName = String(body.fileName ?? "").trim();
    if (!fileName || fileName.includes("/") || fileName.includes("\\")) return error("Invalid WebDAV backup file name", 400);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, payload: Record<string, unknown>) => controller.enqueue(sseFrame(event, payload));
        try {
          await webDavRestore(state.settings.webDavConfig, fileName, (message, percent) => {
            send("progress", { message, percent: percent ?? 0 });
          });
          send("done", { status: "restored", settings: state.settings });
        } catch (err) {
          send("error", { error: friendlyRequestError(err, state.settings.proxyConfig) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: sseHeaders() });
  }
  if (path === "data/s3/config" && request.method === "POST") {
    const body = await readJson<Partial<S3Config>>(request);
    const s3Config = normalizeS3Config(body);
    updateSettings({ ...state.settings, s3Config });
    return json({ status: "ok", config: s3Config });
  }
  if (path === "data/s3/test" && request.method === "POST") {
    const config = normalizeS3Config((await readJson<{ config?: Partial<S3Config> }>(request)).config ?? state.settings.s3Config);
    try {
      await s3TestConnection(config);
      return json({ status: "ok" });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/s3/list" && request.method === "GET") {
    try {
      return json({ items: await s3ListBackups(state.settings.s3Config) });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/s3/backup" && request.method === "POST") {
    try {
      const result = await s3Backup(state.settings.s3Config);
      return json({ status: "ok", ...result, items: await s3ListBackups(state.settings.s3Config) });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/s3/restore" && request.method === "POST") {
    const body = await readJson<{ fileName?: string }>(request);
    const fileName = String(body.fileName ?? "").trim();
    // 有意只拒 "\":S3 key 合法含 "/"(前缀目录),与 WebDAV 的双拒不对称;真实 key
    // 均由 s3ListBackups 返回,服务端仅作 sanity 过滤。
    if (!fileName || fileName.includes("\\")) return error("Invalid S3 backup file name", 400);
    try {
      await s3Restore(state.settings.s3Config, fileName);
      return json({ status: "restored", settings: state.settings });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/s3/delete" && request.method === "POST") {
    const body = await readJson<{ fileName?: string }>(request);
    const fileName = String(body.fileName ?? "").trim();
    if (!fileName || fileName.includes("\\")) return error("Invalid S3 backup file name", 400);
    try {
      await s3Delete(state.settings.s3Config, fileName);
      return json({ status: "deleted", items: await s3ListBackups(state.settings.s3Config) });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/s3/backup/stream" && request.method === "POST") {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, payload: Record<string, unknown>) => controller.enqueue(sseFrame(event, payload));
        try {
          const result = await s3Backup(state.settings.s3Config, (message, percent) => {
            send("progress", { message, percent: percent ?? 0 });
          });
          const items = await s3ListBackups(state.settings.s3Config);
          send("done", { status: "ok", fileName: result.fileName, size: result.size, items });
        } catch (err) {
          send("error", { error: friendlyRequestError(err, state.settings.proxyConfig) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: sseHeaders() });
  }
  if (path === "data/s3/restore/stream" && request.method === "POST") {
    const body = await readJson<{ fileName?: string }>(request);
    const fileName = String(body.fileName ?? "").trim();
    if (!fileName || fileName.includes("\\")) return error("Invalid S3 backup file name", 400);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, payload: Record<string, unknown>) => controller.enqueue(sseFrame(event, payload));
        try {
          await s3Restore(state.settings.s3Config, fileName, (message, percent) => {
            send("progress", { message, percent: percent ?? 0 });
          });
          send("done", { status: "restored", settings: state.settings });
        } catch (err) {
          send("error", { error: friendlyRequestError(err, state.settings.proxyConfig) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: sseHeaders() });
  }
  if (path === "data/export/status" && request.method === "GET") {
    const cachedDbPath = join(dataDir, "rikka_hub_cached.db");
    let schemaInfo: { identityHash: string; version: number } | null = null;
    if (existsSync(cachedDbPath)) {
      try {
        const db = new Database(cachedDbPath, { readonly: true });
        const hash = (db.query("SELECT identity_hash FROM room_master_table").get() as any)?.identity_hash;
        const ver = (db.query("PRAGMA user_version").get() as any)?.user_version;
        db.close();
        if (hash) schemaInfo = { identityHash: hash, version: ver ?? 0 };
      } catch { /* */ }
    }
    return json({
      hasAndroidSchema: !!schemaInfo,
      schemaInfo,
      conversationCount: getConversationsDb() ? countConversations(getConversationsDb()!) : 0,
    });
  }
  if (path === "data/register-schema" && request.method === "POST") {
    const tmpRoot = join(tempDir(), `rikkahub-schema-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    const zipPath = join(tmpRoot, "upload.zip");
    try {
      // Support both FormData upload and raw body
      const contentType = request.headers.get("content-type") ?? "";
      let zipBuffer: Buffer;
      if (contentType.includes("multipart/form-data")) {
        const formData = await request.formData();
        const file = formData.get("file") as Blob | null;
        if (!file) return error("未找到上传文件", 400);
        zipBuffer = Buffer.from(await file.arrayBuffer());
      } else {
        zipBuffer = Buffer.from(await request.arrayBuffer());
      }
      writeFileSync(zipPath, zipBuffer);
      const extractDir = join(tmpRoot, "extracted");
      mkdirSync(extractDir, { recursive: true });
      if (process.platform === "win32") {
        const script = [
          "Add-Type -AssemblyName System.IO.Compression.FileSystem",
          `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')`,
        ].join("; ");
        Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script]);
      } else {
        Bun.spawnSync(["unzip", "-o", zipPath, "-d", extractDir]);
      }
      const dbFile = join(extractDir, "rikka_hub.db");
      if (!existsSync(dbFile)) return error("备份文件中未找到 rikka_hub.db", 400);
      // Rename WAL files for SQLite to pick up
      for (const [src, dest] of [["rikka_hub-wal", "rikka_hub.db-wal"], ["rikka_hub-shm", "rikka_hub.db-shm"]]) {
        const s = join(extractDir, src);
        const d = join(extractDir, dest);
        if (existsSync(s) && !existsSync(d)) try { renameSync(s, d); } catch { /* */ }
      }
      // Open db (readonly) to read schema, then serialize (consolidates WAL) and cache
      const db = new Database(dbFile, { readonly: true });
      const hash = (db.query("SELECT identity_hash FROM room_master_table").get() as any)?.identity_hash;
      const ver = (db.query("PRAGMA user_version").get() as any)?.user_version ?? 0;
      const bytes = db.serialize();
      db.close();
      if (!hash) return error("无法从数据库中读取 identity_hash", 400);
      const cachedDbPath = join(dataDir, "rikka_hub_cached.db");
      writeFileSync(cachedDbPath, bytes);
      return json({ status: "ok", schemaInfo: { identityHash: hash, version: ver } });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 500);
    } finally {
      try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
    }
  }
  if (path === "data/export/to-path" && request.method === "POST") {
    // 问题5(2.0.0 内测):Tauri 桌面端用系统保存对话框自选导出位置,服务端(与壳同机)把
    // zip 直写目标路径——多 GB 备份零 HTTP 传输、零浏览器下载目录中转。取消场景由前端
    // 保证零残留:先选位置后生成,未选位置时请求根本不会发出。
    // 仅限本机直连:向任意宿主路径写文件的能力不暴露给局域网客户端(它们走 GET 下载流,
    // 备份本就应落在客户端机器上);回环闸语义与 /api/app/shutdown 一致(net-context)。
    if (!isLoopbackRequest(request)) return error("Forbidden: this endpoint is loopback-only", 403);
    const body = await readJson<{ targetPath?: unknown }>(request).catch(() => null);
    const targetPath = body && typeof body.targetPath === "string" ? body.targetPath : "";
    if (!isAbsolute(targetPath) || !targetPath.toLowerCase().endsWith(".zip")) {
      return error("targetPath must be an absolute path ending in .zip", 400);
    }
    if (isWindowsReservedName(basename(targetPath))) {
      return error("targetPath must not be a reserved Windows device name", 400);
    }
    const targetDir = dirname(targetPath);
    try {
      if (!statSync(targetDir).isDirectory()) return error("Target directory does not exist", 400);
    } catch {
      return error("Target directory does not exist", 400);
    }
    // 原子产出:同目录部件文件生成(跨盘 rename 非原子,故不落 tempDir),成功后 rename
    // 就位(同盘原子,覆盖语义与保存对话框的覆盖确认一致);失败清部件,不留半个 zip。
    const partPath = join(targetDir, `.${basename(targetPath)}.part-${Math.random().toString(36).slice(2, 8)}`);
    try {
      const { size, warnings } = createSettingsBackupZipToPath(partPath);
      renameSync(partPath, targetPath);
      return json({ ok: true, size, warnings, fileName: basename(targetPath) });
    } catch (err) {
      try { rmSync(partPath, { force: true }); } catch { /* best-effort */ }
      console.error("[export] to-path failed:", err);
      return error(err instanceof Error ? err.message : String(err), 500);
    }
  }
  if (path === "data/export" && request.method === "GET") {
    // Export as a zip — Android-compatible layout (settings.json + upload/ + skills/) plus
    // a PC-only pc-backup.json for full-fidelity self-restore. Streams the zip directly off
    // disk via Bun.file() so multi-GB exports never go through the JS heap. This replaces
    // the old `.json` path that base64-inlined every uploaded file and OOM'd on users with
    // large attachment libraries (issue reported 2026-05).
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "_").replace(/Z$/, "").replace(/-/g, "").slice(0, 15);
    const exportFileName = `rikkahub-backup-${stamp}.zip`;
    const tmpRoot = join(tempDir(), `rikkahub-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpRoot, { recursive: true });
    const zipPath = join(tmpRoot, exportFileName);
    try {
      const { size, warnings } = createSettingsBackupZipToPath(zipPath);
      // Stream the file as the response body — Bun handles the file-to-stream conversion
      // without buffering. We can't auto-delete the temp dir mid-stream, so register a
      // delayed cleanup; if the user cancels mid-download Bun closes the stream and the
      // next launch's startup cleanup pass (if you have one) eventually reaps the dir.
      const fileStream = Bun.file(zipPath).stream();
      setTimeout(() => {
        try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
      }, 5 * 60 * 1000);
      return new Response(fileStream, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Length": String(size),
          "Content-Disposition": `attachment; filename="${exportFileName}"`,
          // Expose to client so the UI can show "saved as X" in its success toast.
          "X-Export-Filename": exportFileName,
          // B4-①:关键降级项(安卓库失败/附件缺失)以 JSON 透出,前端据此显式警告——
          // 备份"成功但缺件"必须让用户知情,而不是静默产出一个恢复后缺会话/附件的包。
          ...(warnings.length > 0 ? { "X-Export-Warnings": JSON.stringify(warnings) } : {}),
        },
      });
    } catch (err) {
      console.error("[export] failed:", err);
      try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
      return error(err instanceof Error ? err.message : String(err), 500);
    }
  }
  if (path === "data/import" && request.method === "POST") {
    // Two upload paths supported:
    //   • multipart/form-data — legacy path, used by the in-browser import UI for small
    //     backups. `request.formData()` buffers the whole upload in JS heap.
    //   • application/octet-stream — streaming path used for large backups (1-10+ GB).
    //     The frontend sends the raw file body with an `X-Filename` header; we pipe
    //     `request.body` directly to a temp file on disk, never buffering the whole thing
    //     in memory. Required because some users report 10 GB+ backups.
    //
    // Format detection (zip vs PC json) is done on the on-disk file's first 4 bytes after
    // the upload completes, regardless of which path we took.
    const importStartedAt = Date.now();
    const customJsBefore = customJsScriptSignatures(state.settings);
    const tmpRoot = join(dataDir, ".import-tmp");
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
      mkdirSync(tmpRoot, { recursive: true });
      // The on-disk temp file MUST end in `.zip` even though we don't know the format yet —
      // PowerShell's `Expand-Archive` checks the extension (not magic bytes) and refuses
      // anything else with "not a supported archive file format". For the PC-JSON path
      // the extension is a harmless lie; we still detect format from magic bytes below.
      const onDiskPath = join(tmpRoot, "backup.zip");

      const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();
      let originalFilename = request.headers.get("X-Filename") ?? "backup";

      if (contentType.startsWith("application/octet-stream") || contentType.startsWith("application/zip")) {
        // STREAMING PATH — pipe request.body straight to disk.
        const body = request.body;
        if (!body) {
          return error("No request body", 400);
        }
        const writer = Bun.file(onDiskPath).writer();
        const reader = body.getReader();
        let bytesReceived = 0;
        let lastLog = Date.now();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            writer.write(value);
            bytesReceived += value.length;
            // Log every 5s so a 10-minute upload doesn't go silent in the console.
            if (Date.now() - lastLog > 5000) {
              console.log(`[import] streamed ${(bytesReceived / (1024 * 1024)).toFixed(1)} MB so far...`);
              lastLog = Date.now();
            }
          }
        } finally {
          await writer.end();
        }
        console.log(`[import] streamed upload complete: ${originalFilename} ${(bytesReceived / (1024 * 1024)).toFixed(1)} MB`);
      } else {
        // LEGACY MULTIPART PATH — works for small backups only.
        console.log("[import] receiving multipart upload...");
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) {
          console.warn("[import] no file in form data");
          return error("No backup file uploaded", 400);
        }
        originalFilename = file.name;
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        console.log(`[import] multipart file ${file.name} (${sizeMB} MB), buffering then writing to disk...`);
        writeFileSync(onDiskPath, Buffer.from(await file.arrayBuffer()));
      }

      // Detect format from first 4 bytes of the on-disk file.
      const magicBytes = new Uint8Array(await Bun.file(onDiskPath).slice(0, 4).arrayBuffer());
      const isZip = magicBytes.length >= 4 && magicBytes[0] === 0x50 && magicBytes[1] === 0x4B && magicBytes[2] === 0x03 && magicBytes[3] === 0x04;
      console.log(`[import] file format: ${isZip ? "Android zip" : "PC json"}`);

      if (isZip) {
        const summary = applyAndroidZipBackupFromPath(onDiskPath);
        const elapsed = ((Date.now() - importStartedAt) / 1000).toFixed(1);
        console.log(`[import] Android zip processed in ${elapsed}s: settings=${summary.settingsImported} files=${summary.filesImported} skills=${summary.skillsImported} convs=${summary.conversationsImported} dbErr=${summary.dbReadError ?? "none"}`);
        const messages = [
          summary.settingsImported ? "已恢复设置（供应商、助手、搜索服务、MCP、提示注入、世界书、快捷消息）" : "未发现可恢复的设置文件",
          summary.conversationsImported ? `已恢复 ${summary.conversationsImported} 条对话历史` : "",
          summary.filesImported ? `已恢复 ${summary.filesImported} 个附件` : "",
          summary.skillsImported ? `已恢复 ${summary.skillsImported} 个 Skill 文件` : "",
          summary.dbReadError ? `对话历史导入失败：${summary.dbReadError}` : "",
        ].filter(Boolean);
        const zipCustomJsWarning = customJsImportWarning(customJsBefore, state.settings);
        // B2:汇总降级警告(custom_js 安全提醒 + 结构化降级报告),前端据此弹结果卡——
        // 「成功但跳过/降级了 N 项」不再静默。
        const zipWarnings = [
          ...(zipCustomJsWarning ? [zipCustomJsWarning] : []),
          ...buildImportWarnings(summary.report),
        ];
        return json({ status: "imported", source: "android-zip", summary: messages, warnings: zipWarnings, settings: state.settings });
      }
      // PC JSON path — safe to read fully into memory; JSON backups are KB-MB, not GB.
      const text = readFileSync(onDiskPath, "utf-8");
      const body = JSON.parse(text) as { state?: Partial<State>; skills?: unknown } & Partial<State>;
      const jsonReport = applyBackupPayload(body);
      const elapsed = ((Date.now() - importStartedAt) / 1000).toFixed(1);
      console.log(`[import] PC json processed in ${elapsed}s`);
      const jsonCustomJsWarning = customJsImportWarning(customJsBefore, state.settings);
      const jsonWarnings = [
        ...(jsonCustomJsWarning ? [jsonCustomJsWarning] : []),
        ...buildImportWarnings(jsonReport),
      ];
      return json({ status: "imported", source: "pc-json", warnings: jsonWarnings, settings: state.settings });
    } catch (err) {
      const elapsed = ((Date.now() - importStartedAt) / 1000).toFixed(1);
      console.error(`[import] failed after ${elapsed}s:`, err);
      return error(err instanceof Error ? err.message : "Invalid backup file", 400);
    } finally {
      // Always clean up the upload temp dir on success or failure. Avoids accumulating
      // 10+ GB of stale uploads on disk if the user retries.
      try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  return null;
}
