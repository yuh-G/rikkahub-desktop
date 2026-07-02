import { toCanvas, toPng } from "html-to-image";

// canvas 单边像素硬上限。超过会生成残图或抛错,提前拦截。
const MAX_DIMENSION = 32767;

export interface CaptureNodeOptions {
  pixelRatio?: number;
  backgroundColor?: string;
  filter?: (node: Node) => boolean;
}

/**
 * 等 @font-face 注册的字体加载完毕(或超时兜底),避免截图回退到系统字体导致排版
 * 错乱。借鉴 Cherry Studio captureScrollableIframe 的字体处理 —— 分享图里代码块 /
 * 数学公式对字体敏感,等字体就绪是长图排版正常的前提。
 */
async function waitForFonts(timeoutMs = 1500): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  await Promise.race([
    document.fonts.ready,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/**
 * 等容器内所有 <img> 加载完毕(或单张超时)。分享图里的 app logo / 模型 icon /
 * 用户头像 / 消息配图 / 文档缩略图都是异步资源,不等完会让 html-to-image 截出空位。
 * warmup 的预载只触发请求不保证解码完成,这里显式等 load/error 事件更稳。
 */
async function waitForImages(node: HTMLElement, timeoutMs = 3000): Promise<void> {
  const imgs = Array.from(node.querySelectorAll("img"));
  if (imgs.length === 0) return;
  await Promise.all(
    imgs.map((img) => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return Promise.race([
        new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        }),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }),
  );
}

/**
 * 默认 filter:跳过标记了 `data-export-ignore="true"` 的节点(导出图里要剔除的元素,
 * 例如选择模式的勾选框),以及 display:none 的节点(html-to-image 默认仍会遍历到)。
 */
function defaultFilter(node: Node): boolean {
  if (node instanceof HTMLElement) {
    if (node.dataset.exportIgnore === "true") return false;
    if (window.getComputedStyle(node).display === "none") return false;
  }
  return true;
}

/**
 * 把 DOM 节点截图为 PNG dataURL。
 *
 * 稳定性技巧(对齐 Cherry Studio 的 captureScrollable):
 * 1. 等字体加载完(document.fonts.ready,带超时兜底)
 * 2. 校验尺寸不超过 canvas 上限 32767px,超出抛错而不是出残图
 * 3. 预热:先跑一次 toCanvas 让 html-to-image 预载并解码图片资源,结果丢弃 —— 避免首帧
 *    图片未解码导致空白(消息里的配图 / 模型 logo 是异步资源)
 * 4. cacheBust 防图片缓存、filter 过滤隐藏元素
 */
export async function captureNodeAsPng(
  node: HTMLElement,
  options: CaptureNodeOptions = {},
): Promise<string> {
  const { pixelRatio = 2, backgroundColor, filter = defaultFilter } = options;

  await waitForFonts();
  await waitForImages(node);

  const width = node.scrollWidth;
  const height = node.scrollHeight;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(
      `内容过长无法导出图片 (${width}×${height}),单边上限 ${MAX_DIMENSION}px。请减少选中的消息数量。`,
    );
  }

  const captureOptions = {
    pixelRatio,
    cacheBust: true,
    backgroundColor,
    filter,
    width,
    height,
  };

  // 预热:让 html-to-image 预载图片资源并解码。结果丢弃。
  const warmup = await toCanvas(node, captureOptions);
  warmup.width = 0;
  warmup.height = 0;

  return toPng(node, captureOptions);
}

/** 触发浏览器下载 dataURL 为文件(与 downloadMarkdown 同款用法)。 */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
