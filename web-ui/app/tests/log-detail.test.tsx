// 日志详情的正文区(PF.4):列表接口不带正文,点开某一条才按 id 取;正文可能已因内存预算被释放,
// 也可能整条已不在服务端。三种情况各给一句说明,并显示正文大小;正常取回时照旧显示正文。
import { beforeEach, describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LogDetailContent } from "~/components/settings/logs";
import i18n from "~/i18n";
import type { RequestLog } from "@server/foundation/types";
import zh from "~/locales/zh-CN/settings.json";
import en from "~/locales/en-US/settings.json";

const base: RequestLog = { id: "l1", at: 1, providerId: "p1", providerName: "Fake", url: "https://example.test/v1/chat", ok: true, status: 200, method: "POST" };
const render = (log: RequestLog, loading = false, unavailable = false) =>
  renderToStaticMarkup(React.createElement(LogDetailContent, { log, loading, unavailable }));

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("日志详情的正文区", () => {
  test("正常:显示正文与大小,不出现说明文字", () => {
    const html = render({ ...base, requestBody: "plain request text", requestBodyLength: 18, responseBody: "plain response", responseBodyLength: 14 });
    expect(html).toContain("plain request text");
    expect(html).toContain("plain response");
    expect(html).toContain("18 字符");
    expect(html).not.toContain(zh.logs.body_released);
    expect(html).not.toContain(zh.logs.body_loading);
  });

  test("取回之前:两处正文都显示加载中,不拿列表里截短的错误文本冒充响应体", () => {
    const html = render({ ...base, ok: false, status: 500, error: "截短的错误…", requestBodyLength: 12 }, true);
    expect(html.split(zh.logs.body_loading).length - 1).toBe(2);
    expect(html).toContain("12 字符");
  });

  test("正文已释放:说明文字 + 原来的大小", () => {
    const html = render({ ...base, bodiesReleased: true, requestBodyLength: 3_200_000, responseBodyLength: 900 });
    expect(html.split(zh.logs.body_released).length - 1).toBe(2);
    expect(html).toContain((3_200_000).toLocaleString());
    expect(html).not.toContain(zh.logs.no_request_body);
  });

  test("整条已不在服务端:说明文字", () => {
    const html = render({ ...base, requestBodyLength: 10 }, false, true);
    expect(html).toContain(zh.logs.body_unavailable);
  });

  test("英文界面同样成对", async () => {
    await i18n.changeLanguage("en-US");
    const html = render({ ...base, bodiesReleased: true, requestBodyLength: 5 });
    expect(html).toContain(en.logs.body_released);
    expect(html).toContain("5 chars");
  });
});
