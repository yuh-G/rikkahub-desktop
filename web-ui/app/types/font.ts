// 字体目录条目。与 pc-server/server.ts 的 FontEntry 保持一致(手动同步,无编译期链接)。
export interface FontEntry {
  /** catalog 内唯一 id:`builtin:<file>` / `custom:<file>` / `system:<name>` */
  id: string;
  /** 下拉框显示名 */
  label: string;
  /** @font-face 的 font-family 名(builtin/custom);system 即族名本身。必须与 family 链首项一致。 */
  cssName: string;
  /** 完整 CSS font-family 值(含 fallback 链)——这是实际注入 CSS 变量的值。 */
  family: string;
  source: "builtin" | "custom" | "system";
  /** builtin/custom 的文件名,前端拼 @font-face 的 src url 用。 */
  fileName?: string;
  /** woff2/truetype/...,@font-face 的 format() 提示。 */
  format?: string;
}

export interface FontCatalog {
  builtin: FontEntry[];
  custom: FontEntry[];
  system: FontEntry[];
}
