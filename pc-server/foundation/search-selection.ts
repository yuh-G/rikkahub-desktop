// 删除一个搜索服务后,全局当前搜索服务(下标)的去向。前后端共用此一处(web-ui 经 @server
// 引用,故本模块必须零 Bun/node 依赖):乐观更新与服务端落库必须同一结果,否则 SSE 回推
// 之前界面显示的「当前服务」与实际不一致。
//
// 规则:当前服务仍在 → 跟着它走(删掉它前面的项时下标前移);删的正是当前服务 → 落到
// 补位的下一项(已是末尾则前一项);列表删空 → 0。
export function searchSelectionAfterDelete(
  services: ReadonlyArray<{ id?: unknown }>,
  selected: number,
  removedId: string,
): number {
  const removedIndex = services.findIndex((item) => String(item.id) === removedId);
  const remaining = services.length - (removedIndex >= 0 ? 1 : 0);
  if (remaining <= 0) return 0;
  const current = Math.min(Math.max(0, selected), services.length - 1);
  if (removedIndex < 0) return Math.min(current, remaining - 1);
  if (removedIndex < current) return current - 1;
  return Math.min(current, remaining - 1);
}
