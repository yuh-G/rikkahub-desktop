const DEFAULT_MAX_IMAGE_DIMENSION = 10_000;
const DEFAULT_MAX_IMAGE_PIXELS = 16_000_000;
const DEFAULT_JPEG_QUALITY = 0.85;

export function calculateImageSampleSize(
  width: number,
  height: number,
  maxDimension = DEFAULT_MAX_IMAGE_DIMENSION,
  maxPixels = DEFAULT_MAX_IMAGE_PIXELS,
) {
  if (width <= 0 || height <= 0) return 1;

  let sampleSize = 1;
  while (
    height / sampleSize > maxDimension ||
    width / sampleSize > maxDimension ||
    (width / sampleSize) * (height / sampleSize) > maxPixels
  ) {
    sampleSize *= 2;
  }
  return sampleSize;
}

async function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

async function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片解码失败"));
    image.src = dataUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function normalizeImageForModelUpload(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") {
    return file;
  }

  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(dataUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const sampleSize = calculateImageSampleSize(width, height);
  const targetWidth = Math.max(1, Math.round(width / sampleSize));
  const targetHeight = Math.max(1, Math.round(height / sampleSize));
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  if (!context) return file;

  context.drawImage(image, 0, 0, targetWidth, targetHeight);
  const blob = await canvasToBlob(canvas, "image/jpeg", DEFAULT_JPEG_QUALITY);
  if (!blob) return file;

  const name = file.name.replace(/\.[^.]+$/, "") || "image";
  return new File([blob], `${name}.jpg`, { type: "image/jpeg" });
}
