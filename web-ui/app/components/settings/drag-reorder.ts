// components/settings/drag-reorder.ts — 设置左栏列表的拖拽排序(挤动动画版)。
//
// 单一模块级控制器接管所有列表(供应商/助手/搜索/语音/拓展)的拖拽:HTML5 DnD 的拖影不可
// 定制、拖动过程中其它行纹丝不动(用户要的「经过时被挤开」做不了),故改为指针驱动:
//   1. 按住拖拽把手(GripVertical)起拖,被拖行随指针 translateY,提层 + 白卡浮起材质;
//   2. 移动中按指针 Y 做「过半即换位」判定,实时把预览序列重排(DOM 直插);每次换位对
//      受影响的兄弟行做 **FLIP**:换位前记旧位,重排后把「旧位-新位」写成内联 transform 再清零
//      ——CSS transition 接管,行平滑滑开/合拢(挤动 = live reorder 的视觉效果本体);
//   3. 松手提交 onMove(from, to)(调用方都是先乐观更新状态再落库,顺序瞬接,无跳变)。
//
// 两个关键不变量(反复踩坑后定稿,勿改):
//   - **换位判定用等差槽位模型,全程不读 DOM rect**:挤动行的 FLIP/CSS 过渡期间
//     getBoundingClientRect 处于半途值,拿它做中点判定会在指针附近抖动、连环换位
//     (步步追移动中的靶子)。列表行高一致、间距一致,槽位 = 首行布局位 + i×步长,
//     槽位模型在重排/过渡/滚动的任何时刻都稳定(判定用视口坐标,滚动时实时换算锚点)。
//   - **FLIP 只作用于换位涉及的行**:每次换位只记「被拖行跳过的那段」的旧位。全程记录
//     全表会与下一次换位的补偿互相踩踏。
//
// 交互细节:
//   - 阈值 4px 才算拖拽:点一下把手(无移动)什么也不发生;
//   - 列表在滚动容器里(双栏各自内滚):指针贴近上下缘时自动滚(滚动改锚点,判定不失效);
//   - prefers-reduced-motion:换位判定照常(顺序反馈仍在),FLIP 行位移瞬时(transition: none)。
//
// 为什么不用 dnd-kit/Reorder(motion):引入新依赖 + 全量改行结构,而我们的行是
// DropdownMenu 包着的复杂复合体;这里零依赖、不碰行内部结构,表面积最小。
import * as React from "react";

/** 拖拽会话的 DOM 侧状态(不动 React 状态:60fps 的指针事件里 setState 会掉帧)。 */
type DragSession = {
  /** 被拖行的元素。 */
  dragEl: HTMLElement;
  /** 列表容器(所有排序行的共同父级)。槽位锚点用它——容器自身从不被 FLIP/指针移动。 */
  list: HTMLElement;
  /** 当前预览序列里参与排序的行(含被拖行,随换位刷新顺序)。 */
  rows: HTMLElement[];
  /** 起拖时被拖行的下标(onMove 的 from)。 */
  from: number;
  /** 当前预览序列里被拖行的下标(松手即 onMove 的 to)。 */
  current: number;
  /** 起拖 Y,位移 = clientY - startY。 */
  startY: number;
  /** 槽位几何:首行槽位相对列表容器的偏移(恒定),与行步长(行高+间距)。 */
  slotOffset: number;
  slotStep: number;
  /** 松手时的提交回调(由起拖入口注入)。 */
  onCommit: (from: number, to: number) => void;
  /** 滚动祖先(双栏内滚容器;无则不自动滚)。 */
  scroller: HTMLElement | null;
  /** 自动滚动循环句柄。 */
  scrollRaf: number;
  /** 收尾清理(摘类、清 transform、解光标)。 */
  cleanup: () => void;
};

let session: DragSession | null = null;

/** 被拖行与挤动行的过渡/材质类,由 app.css 的 .rk-drag-* 承载。 */
const DRAGGING_CLASS = "rk-drag-row";
const SHIFTING_CLASS = "rk-drag-shift";

/** 找元素的可滚动祖先(overflow-y:auto/scroll 的最近一个)。 */
function findScroller(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement;
  while (node && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * 指针 Y 落在哪个槽位(0..count):过某槽位中点即认为该槽让位。
 * 槽位 = 列表容器 top + 首行偏移 + i×步长(等差模型,见文件头不变量说明)。
 */
function dropSlotAt(s: DragSession, y: number): number {
  const step = s.slotStep;
  const base = s.list.getBoundingClientRect().top + s.slotOffset;
  for (let i = 0; i < s.rows.length; i++) {
    const slotTop = base + i * step;
    if (y < slotTop + step / 2) return i;
  }
  return s.rows.length;
}

/**
 * 把被拖行换到 toSlot(可见序列、不含被拖行的下标;dropSlot 语义 = 插到该槽),
 * 并对受影响的兄弟行做 FLIP。受影响的行 = 被拖行跳过的那段(它们是被挤开/收回的行)。
 */
function applyPreview(s: DragSession, dropSlot: number): void {
  if (dropSlot === s.current) return;
  const parent = s.dragEl.parentElement;
  if (!parent) return;

  const visible = s.rows.filter((row) => row !== s.dragEl);
  const fromSlot = s.current;
  const toSlot = Math.min(dropSlot, visible.length);

  // FLIP 第一拍:受影响的行记换位前的布局位。布局位不能读 rect(过渡半途值),
  // 用等差模型反推:该行换位前在 visible 序列里的绝对槽位 × 步长 + 列表锚点
  // (换位前 dragEl 尚在 fromSlot,可见序列第 i 行的绝对槽位 = i + (i >= fromSlot ? 1 : 0))。
  const step = s.slotStep;
  const base = s.list.getBoundingClientRect().top + s.slotOffset;
  const lo = Math.min(fromSlot, toSlot);
  const hi = Math.max(fromSlot, toSlot);
  const affected: Array<{ row: HTMLElement; oldTop: number }> = [];
  for (let i = lo; i < hi; i++) {
    affected.push({ row: visible[i], oldTop: base + (i + (i >= fromSlot ? 1 : 0)) * step });
  }

  // 重排:insertBefore 立即改变布局(布局属性不参与 transition)。
  const anchor = visible[toSlot] ?? null;
  if (anchor) parent.insertBefore(s.dragEl, anchor);
  else parent.appendChild(s.dragEl);

  // FLIP 第二拍:受影响的行已在新布局槽位,补内联 transform 让视觉停在旧槽。
  // 新绝对槽位同理反推:换位后 dragEl 在 toSlot,可见序列第 i 行 = i + (i >= toSlot ? 1 : 0)。
  // 同时内联 transition:none 关掉这一拍的过渡(否则「写 delta」本身会被动画,FLIP 失效)。
  for (let i = 0; i < affected.length; i++) {
    const visIdx = lo + i;
    const row = affected[i].row;
    const oldTop = affected[i].oldTop;
    const delta = oldTop - (base + (visIdx + (visIdx >= toSlot ? 1 : 0)) * step);
    if (delta !== 0) {
      row.style.transition = "none";
      row.style.transform = `translateY(${delta}px)`;
    }
  }
  // FLIP 第三拍:强制回流后清零,transition 从旧位滑向新位。
  void parent.offsetHeight;
  for (const { row } of affected) {
    if (row.style.transform !== "") {
      row.style.transition = "";
      row.style.transform = "";
    }
  }

  // 同步 rows 序列(换位后的可见顺序),供下一次判定与最终提交。
  visible.splice(toSlot, 0, s.dragEl);
  s.rows = visible;
  s.current = toSlot;
}

/** 自动滚动:指针在滚动容器上下 32px 缘内时持续滚,挤动判定随指针同步刷新。 */
function autoScrollTick(s: DragSession, clientY: number): void {
  const scroller = s.scroller;
  if (scroller) {
    const rect = scroller.getBoundingClientRect();
    const edge = 32;
    const top = rect.top + edge;
    const bottom = rect.bottom - edge;
    let speed = 0;
    if (clientY < top) speed = -Math.min(12, (top - clientY) / 2 + 2);
    else if (clientY > bottom) speed = Math.min(12, (clientY - bottom) / 2 + 2);
    if (speed !== 0) {
      scroller.scrollTop += speed;
      dragMove(s, clientY);
    }
  }
  s.scrollRaf = requestAnimationFrame(() => autoScrollTick(s, clientY));
}

function dragMove(s: DragSession, clientY: number): void {
  s.dragEl.style.transform = `translateY(${clientY - s.startY}px)`;
  const absSlot = dropSlotAt(s, clientY);
  // absSlot 是全表槽位(含被拖行);applyPreview 用可见序列(不含被拖行)的下标。
  // 指针越过的槽位若在被拖行之后,可见下标 = 绝对槽位 - 1,反之原样。
  const dragAbs = s.rows.indexOf(s.dragEl);
  const visSlot = absSlot > dragAbs ? absSlot - 1 : absSlot;
  applyPreview(s, visSlot);
}

/**
 * 起拖入口:列表行把拖拽把手的 onPointerDown 转发到这里。把手须有 `data-drag-handle`,
 * 所在行根上有 `data-sort-id`(兄弟行按该属性识别)。
 */
export function startRowDrag(event: React.PointerEvent, onCommit: (from: number, to: number) => void): void {
  if (event.button !== 0) return;
  const handle = event.currentTarget as HTMLElement;
  const row = handle.closest<HTMLElement>("[data-sort-id]");
  const list = row?.parentElement;
  if (!row || !list) return;
  const rows = Array.from(list.children).filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute("data-sort-id"),
  );
  const from = rows.indexOf(row);
  if (from === -1) return;

  // 阈值内不动 DOM:先挂监听,越过 4px 才正式起拖(点一下把手 = 普通点击)。
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const startY = event.clientY;
  let started = false;

  const onMove = (e: PointerEvent) => {
    if (!started) {
      if (Math.abs(e.clientY - startY) < 4) return;
      started = true;
      begin(e.clientY);
    }
    dragMove(session!, e.clientY);
  };

  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    const s = session;
    session = null;
    if (!s) return;
    const toIndex = s.current;
    s.cleanup();
    if (commit && toIndex !== s.from) onCommit(s.from, toIndex);
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);

  const begin = (clientY: number) => {
    // 槽位几何:起拖瞬间没有任何过渡,此刻的 rect 是真布局位。首行槽位以列表容器为锚
    // (容器自身从不被 FLIP/指针移动,滚动时它的视口 top 同步变,锚天然跟随)。
    const scroller = findScroller(row);
    const firstRect = rows[0].getBoundingClientRect();
    const nextRect = rows[1]?.getBoundingClientRect();
    // 行步长 = 相邻行 top 差(含 space-y 间距);只有一行时无换位可言,step 取 0
    // 让判定恒为 0/len,行为退化为无操作。
    const step = nextRect ? nextRect.top - firstRect.top : 0;
    const slotOffset = firstRect.top - list.getBoundingClientRect().top;
    const s: DragSession = {
      dragEl: row,
      list,
      rows,
      from,
      current: from,
      startY: clientY,
      slotOffset,
      slotStep: step,
      onCommit,
      scroller,
      scrollRaf: 0,
      cleanup: () => {},
    };
    session = s;
    row.classList.add(DRAGGING_CLASS);
    if (reduced) row.classList.add("rk-drag-instant");
    for (const other of rows) {
      if (other !== row) other.classList.add(SHIFTING_CLASS);
    }
    document.body.classList.add("rk-dragging-cursor");
    s.cleanup = () => {
      cancelAnimationFrame(s.scrollRaf);
      row.classList.remove(DRAGGING_CLASS, "rk-drag-instant");
      row.style.transform = "";
      for (const other of rows) {
        other.classList.remove(SHIFTING_CLASS);
        other.style.transform = "";
        other.style.transition = "";
      }
      document.body.classList.remove("rk-dragging-cursor");
    };
    s.scrollRaf = requestAnimationFrame(() => autoScrollTick(s, clientY));
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}
