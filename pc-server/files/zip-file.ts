// files/zip-file.ts — 中央目录随机访问 zip 读取器
// 纪律:对齐安卓 java.util.zip.ZipFile 语义——打开时只读 EOCD+中央目录(几十 KB 级),
// 条目按需解压,绝不解压未请求的条目。这是文档解析(DOCX/PPTX/EPUB)的内存下界:
// 一个塞满图片的 PPTX,峰值内存 = 单个 slide XML,而不是全部条目解压后的总体积。
// 仅支持 store(0)/deflate(8) 两种压缩方式,与安卓 ZipInputStream/ZipFile 的实际覆盖一致。
// 含 zip64 支持(>4GB 归档/条目偏移,对齐 java.util.zip.ZipFile)。

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

export interface ZipEntryMeta {
  name: string;
  /** 0=store, 8=deflate */
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** 建档系统是 unix 时外部属性高 16 位里的文件类型与权限(符号链接 = 0o120000);其它系统为 0。 */
  unixMode: number;
}

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
/** EOCD 定长 22 字节 + zip 注释最长 65535 + zip64 定位记录 20 字节 */
const EOCD_SEARCH_TAIL = 22 + 65535 + 20;

export class ZipFileReader {
  private fd: number;
  private fileSize: number;
  private list: ZipEntryMeta[] = [];
  private byName = new Map<string, ZipEntryMeta>();

  constructor(path: string) {
    this.fd = openSync(path, "r");
    try {
      this.fileSize = fstatSync(this.fd).size;
      this.parseCentralDirectory();
    } catch (err) {
      closeSync(this.fd);
      throw err;
    }
  }

  private readAt(position: number, length: number): Buffer {
    const buf = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const n = readSync(this.fd, buf, total, length - total, position + total);
      if (n <= 0) break;
      total += n;
    }
    return buf.subarray(0, total);
  }

  private parseCentralDirectory(): void {
    const tailLen = Math.min(this.fileSize, EOCD_SEARCH_TAIL);
    const tailPos = this.fileSize - tailLen;
    const tail = this.readAt(tailPos, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip file (EOCD signature missing)");
    let count: number = tail.readUInt16LE(eocd + 10);
    let cdSize: number = tail.readUInt32LE(eocd + 12);
    let cdOffset: number = tail.readUInt32LE(eocd + 16);
    // zip64:EOCD 字段饱和时,真实值在 zip64 EOCD 记录里(其位置由 EOCD 前 20 字节的定位记录给出)。
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locAt = eocd - 20;
      if (locAt >= 0 && tail.readUInt32LE(locAt) === EOCD64_LOCATOR_SIG) {
        const eocd64Pos = Number(tail.readBigUInt64LE(locAt + 8));
        const rec = this.readAt(eocd64Pos, 56);
        if (rec.length >= 56 && rec.readUInt32LE(0) === EOCD64_SIG) {
          count = Number(rec.readBigUInt64LE(32));
          cdSize = Number(rec.readBigUInt64LE(40));
          cdOffset = Number(rec.readBigUInt64LE(48));
        }
      }
    }
    const cd = this.readAt(cdOffset, cdSize);
    let off = 0;
    for (let i = 0; i < count && off + 46 <= cd.length; i += 1) {
      if (cd.readUInt32LE(off) !== CEN_SIG) break;
      const madeBy = cd.readUInt16LE(off + 4);
      const compression = cd.readUInt16LE(off + 10);
      let compressedSize: number = cd.readUInt32LE(off + 20);
      let uncompressedSize: number = cd.readUInt32LE(off + 24);
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      const externalAttributes = cd.readUInt32LE(off + 38);
      let localHeaderOffset: number = cd.readUInt32LE(off + 42);
      const name = cd.subarray(off + 46, off + 46 + nameLen).toString("utf8");
      // zip64 扩展字段(id 0x0001):只有饱和(0xFFFFFFFF)的字段才出现,固定按
      // uncompressed → compressed → offset 的顺序排列。
      if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        let ep = off + 46 + nameLen;
        const epEnd = ep + extraLen;
        while (ep + 4 <= epEnd) {
          const fieldId = cd.readUInt16LE(ep);
          const fieldSize = cd.readUInt16LE(ep + 2);
          if (fieldId === 0x0001) {
            let fp = ep + 4;
            if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(cd.readBigUInt64LE(fp)); fp += 8; }
            if (compressedSize === 0xffffffff) { compressedSize = Number(cd.readBigUInt64LE(fp)); fp += 8; }
            if (localHeaderOffset === 0xffffffff) { localHeaderOffset = Number(cd.readBigUInt64LE(fp)); }
            break;
          }
          ep += 4 + fieldSize;
        }
      }
      off += 46 + nameLen + extraLen + commentLen;
      if (!name || name.endsWith("/")) continue;
      const unixMode = madeBy >> 8 === 3 ? externalAttributes >>> 16 : 0;
      const meta: ZipEntryMeta = { name, compression, compressedSize, uncompressedSize, localHeaderOffset, unixMode };
      this.list.push(meta);
      if (!this.byName.has(name)) this.byName.set(name, meta);
    }
  }

  entries(): readonly ZipEntryMeta[] {
    return this.list;
  }

  getEntry(name: string): ZipEntryMeta | undefined {
    return this.byName.get(name);
  }

  /** 解压单个条目(只有该条目的字节进内存)。条目缺失/损坏/压缩方式不支持返回 null。 */
  readEntry(entry: string | ZipEntryMeta): Buffer | null {
    const meta = typeof entry === "string" ? this.byName.get(entry) : entry;
    if (!meta) return null;
    try {
      const header = this.readAt(meta.localHeaderOffset, 30);
      if (header.length < 30 || header.readUInt32LE(0) !== LOC_SIG) return null;
      // 本地头的 name/extra 长度可能与中央目录不同(zip64/流式写入),必须按本地头算数据起点。
      const nameLen = header.readUInt16LE(26);
      const extraLen = header.readUInt16LE(28);
      const raw = this.readAt(meta.localHeaderOffset + 30 + nameLen + extraLen, meta.compressedSize);
      if (raw.length !== meta.compressedSize) return null;
      if (meta.compression === 0) return raw;
      // 中央目录登记的解压大小即上限:谎报大小的条目按损坏处理(防解压炸弹撑爆内存)。
      if (meta.compression === 8) return inflateRawSync(raw, { maxOutputLength: Math.max(1, meta.uncompressedSize) });
      return null;
    } catch {
      return null;
    }
  }

  close(): void {
    try { closeSync(this.fd); } catch { /* 已关闭 */ }
  }
}

/** 便捷包装:打开→回调→保证关闭。 */
export function withZipFile<T>(path: string, fn: (zip: ZipFileReader) => T): T {
  const zip = new ZipFileReader(path);
  try {
    return fn(zip);
  } finally {
    zip.close();
  }
}
