// components/settings/default-models.tsx — 默认模型与系统提示词分区（纯搬迁自 routes/settings.tsx）

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  FileClock,
  FileImage,
  Globe,
  NotebookText,
  RefreshCw,
  Settings2,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import api from "~/services/api";
import type { Settings } from "~/types";
import { SectionHeader, textValue } from "~/components/settings/shared";

type ModelKey =
  | "chatModelId"
  | "fastModelId"
  | "translateModeId"
  | "imageGenerationModelId"
  | "ocrModelId"
  | "compressModelId"
  | "promptOptimizeModelId";

/** 兜底档:未设置时自动跟随会话模型(提示词优化/翻译/上下文压缩)。快速模型是静默档
 *  (未设置=标题用首条消息文本、建议不生成),OCR/图像生成是报错档(未设置=功能不可用)。 */
const FALLBACK_MODEL_KEYS = new Set<ModelKey>([
  "promptOptimizeModelId",
  "translateModeId",
  "compressModelId",
]);

const DEFAULT_PROMPTS = {  titlePrompt: `I will give you some dialogue content in the \`<content>\` block.
You need to summarize the conversation between user and assistant into a short title.
1. The title language should be consistent with the user's primary language
2. Do not use punctuation or other special symbols
3. Reply directly with the title
4. Summarize using {locale} language
5. The title should not exceed 15 characters

<content>
{content}
</content>`,
  translatePrompt: `You are a translation expert, skilled in translating various languages, and maintaining accuracy, faithfulness, and elegance in translation.
Next, I will send you text. Please translate it into {target_lang}, and return the translation result directly, without adding any explanations or other content.

Please translate the <source_text> section:

<source_text>
{source_text}
</source_text>`,
  suggestionPrompt: `I will provide you with some chat content in the \`<content>\` block, including conversations between the User and the AI assistant.
You need to act as the **User** to reply to the assistant, generating 3~5 appropriate and contextually relevant responses to the assistant.

Rules:
1. Reply directly with suggestions, do not add any formatting, and separate suggestions with newlines, no need to add markdown list formats.
2. Use {locale} language.
3. Ensure each suggestion is valid.
4. Each suggestion should not exceed 18 characters.
5. Imitate the user's previous conversational style.
6. Act as a User, not an Assistant!

<content>
{content}
</content>`,
  ocrPrompt: `You are an OCR assistant.

Extract all visible text from the image and also describe any non-text elements (icons, shapes, arrows, objects, symbols, or emojis).

For each element, specify:
- The exact text (for text) or a short description (for non-text).
- For document-type content, please use markdown and latex format.
- If there are objects like buildings or characters, try to identify who they are.
- Its approximate position in the image (e.g., 'top left', 'center right', 'bottom middle').
- Its spatial relationship to nearby elements (e.g., 'above', 'below', 'next to', 'on the left of').

Keep the original reading order and layout structure as much as possible.
Do not interpret or translate-only transcribe and describe what is visually present.`,
  compressPrompt: `You are a conversation compression assistant. Compress the following conversation into a concise summary.

Requirements:
1. Preserve key facts, decisions, and important context that would be needed to continue the conversation
2. Keep the summary in the same language as the original conversation
3. Target approximately {target_tokens} tokens
4. Output the summary directly without any explanations or meta-commentary
5. Format the summary as context information that can be used to continue the conversation
6. Use {locale} language
7. Start the output with a clear indicator that this is a summary (e.g., "[Summary of previous conversation]" or equivalent in the target language)

{additional_context}

<conversation>
{content}
</conversation>`,
  promptOptimizePrompt: `你是一位资深的提示词优化专家。下面会给你一段用户准备发给 AI 助手的话(提示词草稿),你的任务是把它打磨成清晰、得体、表达专业的版本,让 AI 更容易准确理解、给出更好的回复。这段话可能是提问、写作请求、修改要求、闲聊,或任何日常诉求——不限于某个领域。

## 优化原则

1. **严格保留原意,不要无中生有** —— 只能基于用户实际写出的内容来优化,不增加用户没有提出的诉求,不删减已表达的内容,不擅自改变核心意图。不要替用户补充他没有提供的具体信息(比如他说"帮我写封邮件",你不能擅自编造收件人、事由、语气);某处信息缺失或含糊时,就让表达更清楚、更有条理,但不要凭空捏造细节。你的职责是打磨表达,不是替用户重新定义需求。如果原文已经清晰得体,原样输出即可,不要为了优化而画蛇添足。

2. **消除歧义** —— 用户常用模糊或笼统的表述("弄一下""优化一下""帮我处理那个")。如果下方附带了对话背景、且提示词明显在承接它(出现"那个""上面说的""再…一下"等指代),请结合背景理解这些指代具体指向什么;如果没有背景或仍无法确定,保留原表述,不要凭空猜测后替换——错误的猜测比模糊更糟。

3. **让表达更清楚、更有条理** —— 把口语化、啰嗦、跳跃的表述梳理得通顺连贯。如果诉求包含多个要点(背景、需求、约束、期望的输出格式或语气),用分节或编号列表清晰组织;如果只是一句话的简单请求,保持简洁,不要用多余的框架稀释重点——简洁本身就是专业。

4. **用词得体专业** —— 在不改变原意的前提下,把模糊、随意的说法换成更准确、更得体的表达,让模糊的动词变成具体的动作。例如:"帮我弄个东西" → 点明具体要做什么;"写个东西给老板" → 明确是邮件 / 汇报 / 请示中的哪一种;"弄好看点" → 指明是调整措辞 / 优化排版 / 精简结构;"翻译一下" → 点明源语言、目标语言、要保留的风格。注意保持原文的语域——正式的保持规整,轻松的别写得僵硬。

5. **必要时点明隐含期望** —— 如果提示词隐含了目标读者、语气、篇幅、输出格式(如希望分点回答、举例、简短)或希望 AI 扮演的角色,且能从上下文或常识中合理推断,将其显式写出。无法合理推断的不要编造,也不要强加用户没有暗示的要求。

6. **保持原文语言** —— 中文保持中文,英文保持英文,不要翻译,不要自行添加用户未要求的外语。

7. **原样保留特殊内容** —— 原文中的模板占位符(如 {{name}}、{topic}、<url>、[日期])、代码块、数据、公式、引用原样保留,不修改、不"改进"。只优化这些固定内容之外的说明性文字。

## 输出要求

只输出优化后的那段话本身。不要写任何前言、解释、"以下是优化版本"之类的引导语,不要用引号包裹结果,不要在末尾追加说明。用户会把你的输出直接读进输入框——任何提示词以外的文字都是干扰。`,
};

export function DefaultModelsSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  // 本页全是宿主引擎角色(默认聊天/标题/翻译/压缩/OCR…),仅工作区的订阅供应商
  // (Claude Pro/Max,chatCapable=false)不列——宿主闸门会拒绝,选了即陷阱。
  const allModels = settings.providers.flatMap((provider) =>
    provider.enabled && provider.oauthStatus?.chatCapable !== false
      ? (provider.models ?? []).map((model) => ({ ...model, providerName: provider.name }))
      : [],
  );
  // Image generation models live on providers that don't necessarily pass the chat test
  // (image-only providers like findcg gpt-image-2). Source them directly from enabled providers
  // and require an image-related capability marker (parity with images.tsx).
  const imageModels = settings.providers
    .filter((provider) => provider.enabled !== false)
    .flatMap((provider) =>
      (provider.models ?? [])
        .filter(
          (model) =>
            model.type === "IMAGE" ||
            model.outputModalities?.includes("IMAGE") ||
            model.tools?.some(
              (tool) => String(tool.type ?? "").toLowerCase() === "image_generation",
            ),
        )
        .map((model) => ({ ...model, providerName: provider.name })),
    );
  type Draft = {
    chatModelId: string;
    fastModelId: string;
    enableSuggestion: boolean;
    titleGenerationEnabled: boolean;
    translateModeId: string;
    imageGenerationModelId: string;
    ocrModelId: string;
    compressModelId: string;
    promptOptimizeModelId: string;
    promptOptimizePrompt: string;
    titlePrompt: string;
    translatePrompt: string;
    suggestionPrompt: string;
    ocrPrompt: string;
    compressPrompt: string;
  };
  type PromptKey =
    | "titlePrompt"
    | "translatePrompt"
    | "suggestionPrompt"
    | "ocrPrompt"
    | "compressPrompt"
    | "promptOptimizePrompt";
  const [draft, setDraft] = React.useState({
    chatModelId: textValue(settings.chatModelId),
    fastModelId: textValue(settings.fastModelId),
    enableSuggestion: settings.enableSuggestion !== false,
    titleGenerationEnabled: settings.titleGenerationEnabled !== false,
    translateModeId: textValue(settings.translateModeId),
    imageGenerationModelId: textValue(settings.imageGenerationModelId),
    ocrModelId: textValue(settings.ocrModelId),
    compressModelId: textValue(settings.compressModelId),
    promptOptimizeModelId: textValue(settings.promptOptimizeModelId),
    promptOptimizePrompt: textValue(settings.promptOptimizePrompt),
    titlePrompt: textValue(settings.titlePrompt),
    translatePrompt: textValue(settings.translatePrompt),
    suggestionPrompt: textValue(settings.suggestionPrompt),
    ocrPrompt: textValue(settings.ocrPrompt),
    compressPrompt: textValue(settings.compressPrompt),
  } satisfies Draft);
  const [editingPrompt, setEditingPrompt] = React.useState<PromptKey | null>(null);
  // 压缩 prompt 对话框的引擎标签(压缩 prompt 不是公共的:对话引擎可编辑,工作区
  // 引擎 pi 用原生 prompt 只读展示)。其余 prompt 无引擎差异,不显示标签。
  const [compressEngineTab, setCompressEngineTab] = React.useState<"chat" | "pi">("chat");
  // 快速模型卡只有一个「编辑 Prompt」入口,但标题/建议是两条独立提示词 → 对话框内切换编辑,
  // 与压缩 prompt 的分引擎切换同构。fastTab 只在编辑快速模型(promptKey=titlePrompt/suggestionPrompt)时生效。
  const [fastTab, setFastTab] = React.useState<"title" | "suggestion">("title");
  const [piCompactionPrompt, setPiCompactionPrompt] = React.useState<string | null>(null);
  // 对话框内实际编辑的 prompt 键:快速模型卡 → 跟随 fastTab;其余卡 → 卡自身的 promptKey。
  const activePromptKey: PromptKey | null =
    editingPrompt === "titlePrompt" || editingPrompt === "suggestionPrompt"
      ? fastTab === "suggestion"
        ? "suggestionPrompt"
        : "titlePrompt"
      : editingPrompt;
  // 快速模型的对话框是「子功能主页」:标题/建议两页各自在标题行右侧带启停开关,开关只决定
  // 配了快速模型后该子功能跑不跑(标题关 = 首条消息文本命名,建议关 = 不生成)。其余卡的
  // prompt 页无子功能概念,不带开关(它们的「开关」是模型选择器的「未设置」语义)。
  const fastToggleKey: "enableSuggestion" | "titleGenerationEnabled" | null =
    activePromptKey === "titlePrompt"
      ? "titleGenerationEnabled"
      : activePromptKey === "suggestionPrompt"
        ? "enableSuggestion"
        : null;
  React.useEffect(() => {
    // 懒加载:首次打开压缩 prompt 对话框才取 pi 原生 prompt(静态文本,取一次缓存)。
    if (editingPrompt !== "compressPrompt" || piCompactionPrompt !== null) return;
    let cancelled = false;
    api
      .get<{ engines: Array<{ engine: string; prompt: string }> }>("settings/engine-compaction-prompts")
      .then((data) => {
        if (cancelled) return;
        setPiCompactionPrompt(data.engines.find((item) => item.engine === "pi")?.prompt ?? "");
      })
      .catch(() => {
        if (!cancelled) setPiCompactionPrompt("");
      });
    return () => {
      cancelled = true;
    };
  }, [editingPrompt, piCompactionPrompt]);
  const save = async () => {
    await api.post("settings/default-models", draft);
    onSettings({ ...settings, ...draft });
  };
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      void save().catch((error: Error) =>
        toast.error(error.message || t("settings:models.autosave_failed")),
      );
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draft]);
  const modelSelect = (key: ModelKey) => {
    const options = key === "imageGenerationModelId" ? imageModels : allModels;
    // 「未设置」的含义按功能分三档(与后端行为一一对应,勿随意增删档位):
    //   兜底档(优化/翻译/压缩)→ 跟随会话模型;静默档(快速模型)→ 标题用首条消息文本、
    //   建议不生成;报错档(OCR/图像生成)→ 功能不可用,用时提示去配置。
    // 下拉首项文案据此区分,免得用户以为「未设置=不工作」或反之。
    const emptyLabel = FALLBACK_MODEL_KEYS.has(key)
      ? t("settings:models.not_set_fallback")
      : key === "fastModelId"
        ? t("settings:models.not_set")
        : t("settings:models.not_set_disabled");
    // 当前值是否指向真实存在的模型 —— 与后端 modelExists 同口径(扫全部供应商,不限 enabled)。
    // 存在但不在候选里(供应商被停用)时补一条禁用项照实显示,否则 SelectValue 渲染空白;
    // 不存在(出厂 AUTO 哨兵 id / 模型已删除的残留 id)则归到首项,与后端"视作未配置"对齐。
    const selected = settings.providers
      .flatMap((provider) => (provider.models ?? []).map((model) => ({ model, provider })))
      .find((entry) => entry.model.id === draft[key]);
    const listed = options.some((model) => model.id === draft[key]);
    return (
      <Select
        value={selected ? draft[key] : "__none"}
        onValueChange={(value) => setDraft({ ...draft, [key]: value === "__none" ? "" : value })}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">{emptyLabel}</SelectItem>
          {selected && !listed ? (
            <SelectItem value={draft[key]}>
              {selected.provider.name} / {selected.model.displayName || selected.model.modelId}
            </SelectItem>
          ) : null}
          {options.map((model) => (
            <SelectItem key={`${key}-${model.id}`} value={model.id}>
              {model.providerName} / {model.displayName || model.modelId}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  };
  const promptMeta: Record<PromptKey, { title: string; variables: string; defaultValue: string }> =
    {
      titlePrompt: {
        title: t("settings:models.prompt.title"),
        variables: t("settings:models.vars.title"),
        defaultValue: DEFAULT_PROMPTS.titlePrompt,
      },
      translatePrompt: {
        title: t("settings:models.prompt.translate"),
        variables: t("settings:models.vars.translate"),
        defaultValue: DEFAULT_PROMPTS.translatePrompt,
      },
      suggestionPrompt: {
        title: t("settings:models.prompt.suggestion"),
        variables: t("settings:models.vars.suggestion"),
        defaultValue: DEFAULT_PROMPTS.suggestionPrompt,
      },
      ocrPrompt: {
        title: t("settings:models.prompt.ocr"),
        variables: t("settings:models.vars.ocr"),
        defaultValue: DEFAULT_PROMPTS.ocrPrompt,
      },
      compressPrompt: {
        title: t("settings:models.prompt.compress"),
        variables: t("settings:models.vars.compress"),
        defaultValue: DEFAULT_PROMPTS.compressPrompt,
      },
      promptOptimizePrompt: {
        title: t("settings:models.prompt.optimize"),
        variables: t("settings:models.vars.optimize"),
        defaultValue: DEFAULT_PROMPTS.promptOptimizePrompt,
      },
    };
  const features: Array<{
    modelKey: ModelKey;
    promptKey?: PromptKey;
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    description: string;
  }> = [
    {
      modelKey: "chatModelId",
      icon: Bot,
      title: t("settings:models.feature.chat.title"),
      description: t("settings:models.feature.chat.desc"),
    },
    {
      modelKey: "promptOptimizeModelId",
      promptKey: "promptOptimizePrompt",
      icon: Sparkles,
      title: t("settings:models.feature.optimize.title"),
      description: t("settings:models.feature.optimize.desc"),
    },
    {
      modelKey: "fastModelId",
      promptKey: "titlePrompt",
      icon: NotebookText,
      title: t("settings:models.feature.fast.title"),
      description: t("settings:models.feature.fast.desc"),
    },
    {
      modelKey: "translateModeId",
      promptKey: "translatePrompt",
      icon: Globe,
      title: t("settings:models.feature.translate.title"),
      description: t("settings:models.feature.translate.desc"),
    },
    {
      modelKey: "compressModelId",
      promptKey: "compressPrompt",
      icon: FileClock,
      title: t("settings:models.feature.compress.title"),
      description: t("settings:models.feature.compress.desc"),
    },
    {
      modelKey: "ocrModelId",
      promptKey: "ocrPrompt",
      icon: FileImage,
      title: t("settings:models.feature.ocr.title"),
      description: t("settings:models.feature.ocr.desc"),
    },
    {
      modelKey: "imageGenerationModelId",
      icon: WandSparkles,
      title: t("settings:models.feature.image.title"),
      description: t("settings:models.feature.image.desc"),
    },
  ];
  const activePrompt = activePromptKey ? promptMeta[activePromptKey] : null;

  return (
    <>
      <SectionHeader
        icon={Settings2}
        title={t("settings:models.title")}
        subtitle={t("settings:models.subtitle")}
      />
      <div className="space-y-4">
        <div className="rounded-md border bg-card p-3 text-sm text-muted-foreground">
          {t("settings:models.note")}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <div key={feature.modelKey} className="rounded-lg border bg-card p-4">
                <div className="mb-3 flex items-start gap-3">
                  <div className="rounded-md border bg-muted/40 p-2">
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{feature.title}</div>
                    <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {feature.description}
                    </div>
                  </div>
                  {feature.promptKey ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setEditingPrompt(feature.promptKey ?? null)}
                      title={t("settings:models.edit_prompt")}
                    >
                      <Settings2 className="size-4" />
                    </Button>
                  ) : null}
                </div>
                {modelSelect(feature.modelKey)}
              </div>
            );
          })}
        </div>
        <div className="flex justify-end text-xs text-muted-foreground">
          {t("settings:models.autosaved")}
        </div>
      </div>
      <Dialog
        open={Boolean(editingPrompt)}
        onOpenChange={(open) => {
          if (open) return;
          setEditingPrompt(null);
          setCompressEngineTab("chat");
          setFastTab("title");
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <div className="flex items-center justify-between gap-3 pr-8">
              <DialogTitle>{activePrompt?.title ?? "Prompt"}</DialogTitle>
              {fastToggleKey ? (
                <Switch
                  size="sm"
                  checked={draft[fastToggleKey]}
                  onCheckedChange={(checked) => setDraft({ ...draft, [fastToggleKey]: checked })}
                  aria-label={activePrompt?.title}
                />
              ) : null}
            </div>
            <DialogDescription>
              {activePromptKey === "compressPrompt" && compressEngineTab === "pi"
                ? t("settings:models.compress_engine.pi_note")
                : `${t("settings:models.variables_label")}${activePrompt?.variables ?? ""}`}
            </DialogDescription>
          </DialogHeader>
          {activePromptKey === "compressPrompt" ? (
            // 压缩 prompt 分引擎:对话引擎可编辑;工作区引擎(pi)原生内置、只读。
            // 其余 prompt 无引擎差异,不显示此切换。
            <div className="flex gap-1 rounded-lg border bg-muted/40 p-1 self-start">
              {(["chat", "pi"] as const).map((tab) => (
                <Button
                  key={tab}
                  type="button"
                  size="sm"
                  variant={compressEngineTab === tab ? "default" : "ghost"}
                  onClick={() => setCompressEngineTab(tab)}
                >
                  {t(`settings:models.compress_engine.${tab}`)}
                </Button>
              ))}
            </div>
          ) : null}
          {editingPrompt === "titlePrompt" || editingPrompt === "suggestionPrompt" ? (
            // 快速模型下标题/建议两条提示词:对话框内切换编辑(与压缩的分引擎切换同构)。
            <div className="flex gap-1 rounded-lg border bg-muted/40 p-1 self-start">
              {(["title", "suggestion"] as const).map((tab) => (
                <Button
                  key={tab}
                  type="button"
                  size="sm"
                  variant={fastTab === tab ? "default" : "ghost"}
                  onClick={() => setFastTab(tab)}
                >
                  {t(`settings:models.fast_tab.${tab}`)}
                </Button>
              ))}
            </div>
          ) : null}
          {activePromptKey ? (
            activePromptKey === "compressPrompt" && compressEngineTab === "pi" ? (
              <Textarea
                value={piCompactionPrompt ?? "…"}
                readOnly
                className="h-[420px] font-mono text-xs opacity-80"
              />
            ) : (
              <Textarea
                value={draft[activePromptKey]}
                onChange={(event) => setDraft({ ...draft, [activePromptKey]: event.target.value })}
                className="h-[420px] font-mono text-xs"
              />
            )
          ) : null}
          <DialogFooter>
            {activePromptKey && !(activePromptKey === "compressPrompt" && compressEngineTab === "pi") ? (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setDraft({ ...draft, [activePromptKey]: promptMeta[activePromptKey].defaultValue })
                }
              >
                <RefreshCw className="size-4" />
                {t("settings:models.reset_default")}
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={() => {
                setEditingPrompt(null);
                setCompressEngineTab("chat");
                setFastTab("title");
              }}
            >
              {t("settings:models.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
