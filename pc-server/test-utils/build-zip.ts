// test-utils/build-zip.ts — 手工构造 zip(store / deflate 混合)的测试夹具:zip 读取器、文档解析器、插件上传共用。
// corrupt = 故意破坏压缩流;unixMode = 以 unix 建档系统写进外部属性的文件类型与权限(符号链接 0o120777);
// declaredSize = 中央目录里谎报的解压大小(防解压炸弹的用例)。
// CRC 写原始数据的真值:导入备份在 Linux 上交给系统的 unzip 解压,它校验 CRC,写 0 会被拒收(Windows 的 Expand-Archive 不校验)。

import { crc32, deflateRawSync } from "node:zlib";

export type TestZipEntry = { name: string; data: Buffer | string; method?: 0 | 8; corrupt?: boolean; unixMode?: number; declaredSize?: number };

export function buildZip(entries: TestZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const method = e.method ?? 8;
    let packed = method === 8 ? deflateRawSync(raw) : raw;
    if (e.corrupt) packed = Buffer.from(packed.map((b) => b ^ 0xa5));
    const size = e.declaredSize ?? raw.length;
    const checksum = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(e.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(checksum, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(((e.unixMode ?? 0) << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
    chunks.push(local, nameBuf, packed);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}
