// scripts/sync-dist-assets.ts — 编译后把 exe 同级静态资产同步进 dist/。
// routeStatic/serveAIIcon/字体服务在打包布局下按 executableDir 查 icons/ 与 fonts/
// (源码运行走 rootDir 兜底不受影响)。dist/ 整目录 gitignored,一旦被清(换盘/手动
// 清空/初次 clone 后 compile)exe 落地而无这两目录,品牌 Logo 与内置字体全部静默
// 回退兜底字母——表象是"Logo 全变默认",极难从代码侧排查。故 compile 每次幂等
// 重放,缺则补、旧则盖,保证 dist 便携布局永远自洽。
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");
const distDir = join(repoRoot, "dist");

for (const assetDir of ["icons", "fonts"] as const) {
  const src = join(repoRoot, assetDir);
  const dest = join(distDir, assetDir);
  if (!existsSync(src)) continue; // fonts/ 属仓库资产,缺失说明 checkout 不全,不阻断编译
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    if (!statSync(srcPath).isFile()) continue;
    copyFileSync(srcPath, join(dest, entry));
    copied += 1;
  }
  console.log(`[sync-dist-assets] ${assetDir}: ${copied} files -> ${dest}`);
}
