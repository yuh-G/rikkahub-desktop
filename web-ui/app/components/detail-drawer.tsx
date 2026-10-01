import * as React from "react";

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "~/components/ui/drawer";
import { useIsMobile } from "~/hooks/use-mobile";

// "详情抽屉"统一容器:工具调用详情、技能内容等"点卡片看详情"的场景共用同一交互
// 契约,各处只填标题与内容,不再各自拼装 Drawer。统一承担四件事:
//   1. 方向策略——移动端底部抽出、桌面端右侧滑出;
//   2. 文本可选中——vaul 把 Content 上的 pointerdown 当作拖拽起点,会吞掉文本选择;
//      在滚动区截断冒泡 + select-text,正文可自由选中,从头部/把手拖拽关闭仍有效;
//   3. 字体——data-detail-drawer 经 app.css 跟随对话字体(--rikkahub-chat-font),
//      挂在 Content 根上:标题/描述/正文整体入域,详情内容与消息正文观感一致
//      (代码块仍走等宽,规则见 markdown 样式);
//   4. 滚动布局——头部固定,内容区独立滚动。
export function DetailDrawer({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  const isMobile = useIsMobile();
  return (
    <Drawer direction={isMobile ? "bottom" : "right"} open={open} onOpenChange={onOpenChange}>
      <DrawerContent data-detail-drawer>
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
          <DrawerDescription>{description}</DrawerDescription>
        </DrawerHeader>
        <div
          className="flex-1 min-h-0 select-text overflow-y-auto px-4 pb-6"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {children}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
