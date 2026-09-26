// assets/icons.ts — AI 品牌图标服务（lobehub 图标代理 + 本地缓存 + 兜底 SVG）
// 纪律：纯搬迁自 server.ts（阶段 5.3b），行为不变。

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { executableDir, rootDir } from "../foundation/paths";
import { mime } from "../api/request";

function fallbackSvg(name: string) {
  const first = (name.trim()[0] ?? "A")
    .toUpperCase()
    .replace("&", "&amp;")
    .replace("<", "&lt;")
    .replace(">", "&gt;")
    .replace("\"", "&quot;")
    .replace("'", "&apos;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#E9EAEE"/><text x="32" y="38" font-family="system-ui, sans-serif" font-size="24" font-weight="600" text-anchor="middle" fill="#4E5969">${first}</text></svg>`;
}

const iconRules: Array<[RegExp, string]> = [
  [/rikka|auto/i, "rikkahub.svg"],
  [/(gpt|openai|o\d)/i, "openai.svg"],
  [/(gemini|nano-banana)/i, "gemini-color.svg"],
  [/google/i, "google-color.svg"],
  [/claude/i, "claude-color.svg"],
  [/anthropic/i, "anthropic.svg"],
  [/deepseek/i, "deepseek-color.svg"],
  // muse-spark/glimmer(Meta 系,对齐 APP PATTERN_META)落 meta 标。
  [/meta\b|(?<!o)llama|muse/i, "meta-color.svg"],
  [/grok/i, "grok.svg"],
  [/qwen|qwq|qvq/i, "qwen-color.svg"],
  // 豆包:label 是中文"豆包",APP 模式为 doubao|豆包|火山;火山由下方 bytedance 规则兜住,
  // 这里补 doubao|豆包 让搜索服务的中文标签命中豆包专属图标(而非落 bytedance)。
  [/doubao|豆包/i, "doubao-color.svg"],
  [/openrouter/i, "openrouter.svg"],
  [/zhipu|智谱|glm/i, "zhipu-color.svg"],
  [/mistral/i, "mistral-color.svg"],
  // 腾讯混元:新旗舰官方 modelId 为裸小写 hy3/hy4(-preview),不含 hunyuan 字串,补词边界
  // 判定接住(防误伤别家带 hy 的名字);APP 端对 hy3/hy4 无专属图标落 fallback,PC 用混元标更贴。
  [/hunyuan|tencent|腾讯混元|\bhy[3-9]\b/i, "hunyuan-color.svg"],
  [/gemma/i, "gemma-color.svg"],
  [/perplexity/i, "perplexity-color.svg"],
  [/aliyun|阿里云|百炼/i, "alibabacloud-color.svg"],
  [/bytedance|火山/i, "bytedance-color.svg"],
  [/silicon|硅基/i, "siliconflow.svg"],
  [/aihubmix/i, "aihubmix-color.svg"],
  [/ollama/i, "ollama.svg"],
  // GitHub Copilot 订阅预置显示名已精简为「Copilot」——不含 github 字串,须显式命中。
  [/github|copilot/i, "github.svg"],
  [/cloudflare/i, "cloudflare-color.svg"],
  [/minimax/i, "minimax-color.svg"],
  [/xai/i, "xai.svg"],
  [/juhenext/i, "juhenext.png"],
  // 裸 K 系列(词边界):Moonshot K3 起的短格式模型 id(如 "k3"/"k3.5",聚合商列表常见)
  // 不带 kimi 前缀,旧规则漏匹配落灰底字母兜底。\b 保证不误伤 grok-3/deepseek3 等
  // (k 前是字母无词边界)。k2 故意不收:裸 "k2" 与 LLM360 K2 撞名,且 Kimi k2 系列
  // 官方 id 均带 kimi 前缀。
  [/kimi|\bk[3-9](?:\.\d+)?\b/i, "kimi-color.svg"],
  [/moonshot|月之暗面/i, "moonshot.svg"],
  [/302/i, "302ai.svg"],
  [/step|阶跃/i, "stepfun-color.svg"],
  [/intern|书生/i, "internlm-color.svg"],
  [/cohere|command-.+/i, "cohere-color.svg"],
  [/tavern/i, "tavern.png"],
  [/cerebras/i, "cerebras-color.svg"],
  [/nvidia/i, "nvidia-color.svg"],
  [/ppio|派欧/i, "ppio-color.svg"],
  [/vercel/i, "vercel.svg"],
  [/groq/i, "groq.svg"],
  [/tokenpony|小马算力/i, "tokenpony.svg"],
  [/ling|ring|百灵/i, "ling.png"],
  [/mimo|xiaomi|小米/i, "xiaomimimo.svg"],
  [/longcat/i, "longcat-color.svg"],
  [/linkup/i, "linkup.png"],
  [/bing/i, "bing.png"],
  [/tavily/i, "tavily.png"],
  [/exa/i, "exa.png"],
  [/brave/i, "brave.svg"],
  [/metaso|秘塔/i, "metaso.svg"],
  [/firecrawl/i, "firecrawl.svg"],
  [/jina/i, "jina.svg"],
  [/tinyfish/i, "tinyfish.svg"],
  // serper 不在 lobehub 图标库(APP 同样落灰底字母),用官方品牌标(serper.dev 的 S-in-ring)。
  [/serper/i, "serper.png"],
  [/searxng/i, "searxng.svg"],
  [/naapi|钠/i, "naapi.jpg"],
];

export function iconForName(name: string) {
  return iconRules.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

export async function serveAIIcon(name: string) {
  const iconName = iconForName(name);
  if (iconName) {
    const candidates = [
      resolve(executableDir, "icons", iconName),
      resolve(rootDir, "icons", iconName),
    ];
    const target = candidates.find((candidate) => existsSync(candidate));
    if (target) {
      return new Response(Bun.file(target), {
        headers: { "Content-Type": mime(target), "Cache-Control": "public, max-age=86400" },
      });
    }
  }
  return new Response(fallbackSvg(name), {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" },
  });
}
