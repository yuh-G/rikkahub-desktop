// 文件上传的共享逻辑:类型检测、MIME 归一化、上传并把结果加进当前对话草稿。
//
// 这套逻辑同时被两处调用:
//   1. 输入框(chat-input)的"+"按钮、粘贴、以及历史拖拽入口;
//   2. 全窗口拖拽投放区(global-drop-zone)。
// 上传中的 busy 状态存在全局 store(uploading 字段),保证两个入口互斥、且任一入口
// 触发上传时另一处的 UI 都能同步显示"上传中"。
import { fileTypeFromBuffer } from "file-type";
import { toast } from "sonner";

import i18n from "~/i18n";
import { normalizeImageForModelUpload } from "~/lib/image-normalize";
import api from "~/services/api";
import { useAppStore } from "~/stores";
import type { UIMessagePart, UploadFilesResponseDto } from "~/types";

export const DOCUMENT_UPLOAD_ACCEPT = [
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".yaml",
  ".yml",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".epub",
  "application/epub+zip",
].join(",");

const DOCUMENT_MIME_BY_EXTENSION: Record<string, string> = {
  ".epub": "application/epub+zip",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

function extensionOf(name: string) {
  const match = name.toLowerCase().match(/\.[^.]+$/);
  return match?.[0] ?? "";
}

async function detectUploadFile(
  file: globalThis.File,
): Promise<{ allowed: boolean; mimeType: string }> {
  const extension = extensionOf(file.name);
  const buffer = await file.slice(0, 4100).arrayBuffer();
  const detected = await fileTypeFromBuffer(buffer);

  // 无法识别 magic bytes → 文本文件 → 允许，强制 text/plain 防止 OS MIME 映射污染（如 .ts → video/mp2t）
  if (!detected)
    return { allowed: true, mimeType: DOCUMENT_MIME_BY_EXTENSION[extension] ?? "text/plain" };

  // 识别为图片 / 视频 / 音频 → 允许，使用 magic bytes 检测到的 MIME
  if (
    detected.mime.startsWith("image/") ||
    detected.mime.startsWith("video/") ||
    detected.mime.startsWith("audio/")
  ) {
    return { allowed: true, mimeType: detected.mime };
  }

  // 允许常见文档格式
  const ALLOWED_DOCUMENT_MIMES = new Set([
    "application/pdf",
    "application/epub+zip",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ]);
  if (ALLOWED_DOCUMENT_MIMES.has(detected.mime)) {
    return { allowed: true, mimeType: detected.mime };
  }
  if (detected.mime === "application/zip" && extension === ".epub") {
    return { allowed: true, mimeType: "application/epub+zip" };
  }

  // 其他可识别的二进制格式（exe、zip 等）→ 拒绝
  return { allowed: false, mimeType: detected.mime };
}

function toMessagePart(file: UploadFilesResponseDto["files"][number]): UIMessagePart {
  if (file.mime.startsWith("image/")) {
    return {
      type: "image",
      url: file.url,
      metadata: { fileId: file.id },
    };
  }

  if (file.mime.startsWith("video/")) {
    return {
      type: "video",
      url: file.url,
      metadata: { fileId: file.id },
    };
  }

  if (file.mime.startsWith("audio/")) {
    return {
      type: "audio",
      url: file.url,
      metadata: { fileId: file.id },
    };
  }

  return {
    type: "document",
    url: file.url,
    fileName: file.fileName,
    mime: file.mime,
    metadata: { fileId: file.id },
  };
}

export function hasFilesInDataTransfer(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files.length > 0) return true;
  return Array.from(dataTransfer.items).some((item) => item.kind === "file");
}

/**
 * 把一组文件上传到服务端,并把返回的附件 part 喂给 onAddParts(通常写进当前对话草稿)。
 *
 * 上传中的 busy 状态写进全局 store(uploading),这样输入框和全窗口投放区能互斥、且
 * 同步显示"上传中"。是否允许调用(对话就绪、非加载中、非上传中)由调用方判断。
 *
 * @returns `{ error }` —— 出错时返回错误信息,由调用方决定怎么展示(输入框内联显示 /
 *          投放区走 toast)。跳过不支持的文件这类"非致命"情况内部已 toast,不算错误。
 */
export async function uploadFilesToDraft(
  files: FileList | globalThis.File[] | null,
  onAddParts: (parts: UIMessagePart[]) => void,
): Promise<{ error: string | null }> {
  if (!files || files.length === 0) return { error: null };

  const allFiles = Array.from(files);
  // 并发防御:两个入口(输入框按钮/粘贴 + 全窗口投放)各自在上游用 canUpload / canAccept
  // 守过了 uploading,这里再兜一道,确保任何调用路径都不会在上传未结束时重叠发起第二次
  // ——否则先结束的那次会把 uploading 提前清零,让另一边的 UI 误以为已结束。
  const { uploading: alreadyUploading, setUploading } = useAppStore.getState();
  if (alreadyUploading) return { error: null };
  // Set the busy state up front so the user gets immediate feedback even during the
  // (potentially slow) detection + image-normalization phases. Previously these ran
  // before setUploading(true) and outside the try/catch, so any throw in file-type
  // detection or image decoding silently rejected the whole upload with no UI feedback
  // — the "上传后没反应、文件没显示" symptom.
  setUploading(true);
  try {
    const results = await Promise.all(
      allFiles.map(async (f) => {
        try {
          return { file: f, ...(await detectUploadFile(f)) };
        } catch {
          // Detection failed (corrupt buffer, file-type lib error) — fall back to
          // treating it as an allowed plain-text-ish upload rather than dropping it.
          return { file: f, allowed: true, mimeType: f.type || "application/octet-stream" };
        }
      }),
    );
    const uploadableFiles = results.filter((r) => r.allowed);
    const skippedFiles = results.filter((r) => !r.allowed);

    if (skippedFiles.length > 0) {
      toast.warning(i18n.t("input:chat.unsupported_file_skipped", { count: skippedFiles.length }));
    }

    if (uploadableFiles.length === 0) {
      return { error: null };
    }

    const formData = new FormData();
    const safeFiles = await Promise.all(
      uploadableFiles.map(async ({ file, mimeType }) => {
        // 用 magic bytes 检测结果覆盖浏览器的 file.type，修正跨平台 MIME 歧义
        const safeFile =
          file.type !== mimeType
            ? new globalThis.File([file], file.name, { type: mimeType })
            : file;
        // Image normalization can throw on corrupt/unsupported images — never let that
        // abort the whole upload; fall back to the original file.
        try {
          return await normalizeImageForModelUpload(safeFile);
        } catch {
          return safeFile;
        }
      }),
    );
    safeFiles.forEach((safeFile) => {
      formData.append("files", safeFile, safeFile.name);
    });

    const response = await api.postMultipart<UploadFilesResponseDto>("files/upload", formData);
    const parts = response.files.map(toMessagePart);
    onAddParts(parts);
    return { error: null };
  } catch (uploadError) {
    const message =
      uploadError instanceof Error ? uploadError.message : i18n.t("input:chat.upload_failed");
    return { error: message };
  } finally {
    setUploading(false);
  }
}
