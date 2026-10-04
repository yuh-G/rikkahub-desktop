// components/settings/drag-reorder.ts — 设置左栏列表的拖拽排序(投影式挤动)。
//
// 单一模块级控制器接管所有列表(供应商/助手/搜索/语音/拓展)的拖拽,HTML5 DnD 的拖影
// 不可定制、拖动过程中其它行纹丝不动(用户要的「经过时被挤开」做不了),故指针驱动。
//
// 架构:拖动全程**不动 DOM 顺序**(只写 transform,布局位不变),与 dnd-kit 的
// verticalListSortingStrategy 同构——上一版(96f5bd6)拖动中 insertBefore 实时重排,
// 有两个不治之症:
//   1. 不跟手:insertBefore 改的是被拖行的**布局位**,每越过一行它就地跳一格,
//      而内联 translateY 仍按起拖点算,行在指针下抽动一整个步长;
//   2. 挤动剧烈:FLIP 两拍之间被拖行也在换位,每次跨界都重放全步长位移。
// 投影式把两个问题一起消掉:DOM 静止、人人只在原布局位上做纯 transform。
//   - 被拖行:translateY = 指针位移,逐帧贴合(transition: none),材质浮起;
//   - 兄弟行:按「被拖行投影到哪个槽位」反推各自的目标位移——被拖行从 from 抬起
//     落到 to 时,夹在两槽之间的行各让一格(±step),写一次 translateY 后交给
//     CSS transition 缓动,只有跨界那一次增量,位移连续不叠加;
//   - 松手:一次性把被拖行 insertBefore 到提交槽位、清空所有 transform、提交
//     onMove。DOM 重排发生在收尾的一瞬(顺序与投影一致),无可见跳变。
//
// 槽位判定用等差模型(首行偏移 + i×步长),不读过渡中的行 rect——半途值会在指针
// 附近抖动造成连环跨界(上一版的核心教训,保留)。
//
// 交互细节:
//   - 阈值 4px 才算拖拽:点一下把手(无移动)什么也不发生;
//   - 列表在滚动容器里(双栏各自内滚):指针贴近上下缘时自动滚(槽位锚点按视口
//     实时换算,滚动不失效);
//   - prefers-reduced-motion:判定照常(顺序反馈仍在),位移瞬时。
//
// 为什么不用 dnd-kit/Reorder(motion):引入新依赖 + 全量改行结构,而我们的行是
// DropdownMenu 包着的复杂复合体;这里零依赖、不碰行内部结构,表面积最小。
import * as React from "react";

/** 拖拽会话的 DOM 侧状态(不动 React 状态:60fps 的指针事件里 setState 会掉帧)。 */
type DragSession = {
  /** 被拖行的元素。 */
  dragEl: HTMLElement;
  /** 列表容器(所有排序行的共同父级)。槽位锚点用它——容器自身从不动,滚动天然跟随。 */
  list: HTMLElement;
  /** 参与排序的行(DOM 顺序恒定 = 起拖顺序,全程不 insertBefore)。 */
  rows: HTMLElement[];
  /** 起拖槽位(onMove 的 from)。 */
  from: number;
  /** 当前投影槽位(松手即 onMove 的 to)。 */
  current: number;
  /** 起拖 Y,被拖行位移 = clientY - startY。 */
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
 * 指针 Y 落在哪个槽位(0..count):过某槽位中点即认为投影到该槽。
 * 槽位 = 列表容器 top + 首行偏移 + i×步长(等差模型;DOM 静止,槽位是纯布局事实)。
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
 * 投影重摆:被拖行落到 to 槽时,其余行各让到哪。全表写一遍(幂等,跨界时只有
 * 段内行的目标变化):
 *   to 在 from 之后(下移):第 i 行(i ∈ (from, to]) 让 -step(上移补位);
 *   to 在 from 之前(上移):第 i 行(i ∈ [to, from)) 让 +step(下移补位);
 *   其余行位移 0。
 */
function projectShifts(s: DragSession, to: number): void {
  const step = s.slotStep;
  for (let i = 0; i < s.rows.length; i++) {
    const row = s.rows[i];
    if (row === s.dragEl) continue;
    let shift = 0;
    if (to > s.from) {
      if (i > s.from && i <= to) shift = -step;
    } else if (to < s.from) {
      if (i >= to && i < s.from) shift = step;
    }
    // 只有目标变了才写(位移相同时不重写 style,避免打断进行中的缓动)。
    const next = shift === 0 ? "" : `translateY(${shift}px)`;
    if (row.style.transform !== next) row.style.transform = next;
  }
}

/** 自动滚动:指针在滚动容器上下 32px 缘内时持续滚,投影随指针同步刷新。 */
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
  const pointerShift = clientY - s.startY;
  // 投影槽 = 被拖行中心落点(不是指针位置):行比指针高,按行中心判定跨界,行的
  // 视觉覆盖与槽位切换一致,快拖慢拖手感一致。被拖行布局位静止(DOM 顺序不动),
  // 其 rect 是常量,center = 布局位 + 位移合成,每帧稳定。
  // 半高必须取被拖行**自身**的 rect.height/2(dnd-kit rectIntersection 同款),不能用
  // slotStep/2:slotStep 含 space-y 间距(步长 = 行高+间距),用半步长当半高会多算
  // 「间距/2」,且该误差随滑过行数线性累积((n-1)×间距/2)——正是「越滑越提前交换」
  // 的根因。真高度恒定,与滑过行数无关,不累积。
  const dragRect = s.rows[s.from].getBoundingClientRect();
  const center = dragRect.top + pointerShift + dragRect.height / 2;
  const to = dropSlotAt(s, center);
  s.current = to;
  projectShifts(s, to);
  // 用 CSS `translate` 而非 `transform: translateY()`:translate 是独立的合成层属性,
  // 与兄弟行 transform 上的过渡各走各的,逐帧直写无任何缓动纠缠(dnd-kit 同款写法)。
  s.dragEl.style.translate = `0 ${pointerShift}px`;
}

/**
 * 起拖入口:列表行把拖拽把手的 onPointerDown 转发到这里。把手须有 `data-drag-handle`,
 * 所在行根上有 `data-sort-id`(兄弟行按该属性识别)。
 */
export function startRowDrag(event: React.PointerEvent, onCommit: (from: number, to: number) => void): void {
  if (event.button !== 0) return;
  // 阻止浏览器原生拖选/文本选中的默认手势:不拦,指针一移动 Chromium 就会开始在
  // 兄弟行里圈选文本(蓝底高亮),与我们的指针驱动拖拽互相打架。
  event.preventDefault();
  const handle = event.currentTarget as HTMLElement;
  const row = handle.closest<HTMLElement>("[data-sort-id]");
  const list = row?.parentElement;
  if (!row || !list) return;
  const rows = Array.from(list.children).filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute("data-sort-id"),
  );
  const from = rows.indexOf(row);
  if (from === -1) return;

  // 阈值内不动 DOM:先挂监听,越过 6px 才正式起拖(点一下把手 = 普通点击)。
  // 6px 对齐成熟库的起拖激活距离(dnd-kit PointerSensor distance 5~8):给「点按」
  // 留足容错,避免一碰把手就觉得「已经开始换位了」。
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const startY = event.clientY;
  let started = false;

  const onMove = (e: PointerEvent) => {
    if (!started) {
      if (Math.abs(e.clientY - startY) < 6) return;
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
    // 提交前的收尾:被拖行还在原布局位上浮着,兄弟行也让着位。先按投影把 DOM 摆到
    // 最终顺序再清 transform——落定画面与松手瞬间的投影一致,无二次动画。
    if (commit && toIndex !== s.from) {
      const visible = s.rows.filter((r) => r !== s.dragEl);
      const anchor = visible[toIndex] ?? null;
      if (anchor) list.insertBefore(s.dragEl, anchor);
      else list.appendChild(s.dragEl);
    }
    s.cleanup();
    if (commit && toIndex !== s.from) onCommit(s.from, toIndex);
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);

  const begin = (clientY: number) => {
    // 槽位几何:起拖瞬间没有任何过渡,此刻的 rect 是真布局位。首行槽位以列表容器为锚
    // (容器自身从不动,滚动时它的视口 top 同步变,锚天然跟随)。
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
    // 拖动全程关掉文本选择(蓝底高亮):pointerdown 的 preventDefault 只拦了起拖手势,
    // 拖动中指针掠过兄弟行时 Chromium 仍会圈选文本,需在整个会话期压 user-select。
    const previousUserSelect = document.body.style.userSelect;
    document.body.classList.add("rk-dragging-cursor");
    document.body.style.userSelect = "none";
    s.cleanup = () => {
      cancelAnimationFrame(s.scrollRaf);
      row.classList.remove(DRAGGING_CLASS, "rk-drag-instant");
      row.style.translate = "";
      for (const other of rows) {
        other.classList.remove(SHIFTING_CLASS);
        other.style.transform = "";
      }
      document.body.classList.remove("rk-dragging-cursor");
      document.body.style.userSelect = previousUserSelect;
    };
    s.scrollRaf = requestAnimationFrame(() => autoScrollTick(s, clientY));
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}
