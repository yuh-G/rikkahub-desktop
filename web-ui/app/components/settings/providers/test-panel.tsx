// components/settings/providers/test-panel.tsx — 供应商详情 › 测试:选模型 + 三模式连通性测试(聊天模型)
// 或生图测试(IMAGE 模型)。按供应商 key 重挂载,切换供应商即清空上一个的测试结果。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Database, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Notice } from "~/components/ui/notice";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { getModelDisplayName } from "~/lib/display";
import api, { appendWebAuthQuery } from "~/services/api";
import type { ProviderModel, ProviderProfile, Settings } from "~/types";
import { SettingsGroup, SettingsRow, SettingsRows } from "~/components/settings/shared";

type ProviderTestMode = "non_stream" | "stream" | "tools";

interface ProviderTestCheck {
  mode: ProviderTestMode;
  ok: boolean;
  status: number;
  endpoint: string;
  preview: string;
}

interface ProviderTestInfo {
  endpoint: string;
  responseApiEndpoint: string;
  testModelId: string;
  modelCount: number;
  preview: string;
  checks?: ProviderTestCheck[];
}

export function ProviderTestPanel({
  draft,
  fetchedModels,
  onBeforeTest,
  onSettings,
}: {
  draft: ProviderProfile;
  fetchedModels: ProviderModel[];
  /** 测试前确保服务端拿到当前草稿(无条件落一次)。 */
  onBeforeTest: () => Promise<void>;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState("");
  const [testChecks, setTestChecks] = React.useState<ProviderTestCheck[]>([]);
  const [testInfo, setTestInfo] = React.useState<ProviderTestInfo | null>(null);
  const [testModelId, setTestModelId] = React.useState(
    () => draft.models?.find((model) => model.modelId !== "auto")?.modelId ?? "",
  );
  const [imageTestResult, setImageTestResult] = React.useState<{
    url: string;
    durationMs: number;
    modelId: string;
    prompt: string;
  } | null>(null);
  // 刚拉取到上游列表时默认测第一个上游模型(而不是沿用已启用列表里的旧选择)。
  React.useEffect(() => {
    const first = fetchedModels.find((model) => model.modelId !== "auto")?.modelId;
    if (first) setTestModelId(first);
  }, [fetchedModels]);
  const fetchedModelIds = new Set(fetchedModels.map((model) => model.modelId));
  const mergedTestModels = [
    ...fetchedModels,
    ...(draft.models ?? []).filter(
      (model) => model.modelId !== "auto" && !fetchedModelIds.has(model.modelId),
    ),
  ].filter((model) => model.modelId !== "auto");
  const effectiveTestModelId =
    (testModelId && mergedTestModels.some((model) => model.modelId === testModelId)
      ? testModelId
      : mergedTestModels[0]?.modelId) || "";
  // The selected test model's persisted record drives whether we run the image-gen test path
  // (and hide the 3-mode chat panel) vs the chat test path.
  const effectiveTestModelType = (() => {
    const persisted = (draft.models ?? []).find((item) => item.modelId === effectiveTestModelId);
    const merged = mergedTestModels.find((item) => item.modelId === effectiveTestModelId);
    return String(persisted?.type ?? merged?.type ?? "CHAT").toUpperCase();
  })();
  const isImageTestMode = effectiveTestModelType === "IMAGE";
  const testModeLabels: Record<ProviderTestMode, string> = {
    non_stream: t("settings:providers.mode_non_stream"),
    stream: t("settings:providers.mode_stream"),
    tools: t("settings:providers.mode_tools"),
  };
  const test = async () => {
    setTesting(true);
    setTestChecks([]);
    setTestInfo(null);
    setImageTestResult(null);
    // If user picked an IMAGE-type model, run a dedicated image-generation test instead of
    // the 3-mode chat test. Matches Android, which never tries chat completions for IMAGE models.
    const requestedModelId = effectiveTestModelId;
    const selectedTestModel =
      (draft.models ?? []).find((item) => item.modelId === requestedModelId) ??
      mergedTestModels.find((item) => item.modelId === requestedModelId) ??
      null;
    if (selectedTestModel && (selectedTestModel.type as string) === "IMAGE") {
      setTestResult(t("settings:providers.test_img_starting"));
      try {
        await onBeforeTest();
        const started = Date.now();
        const response = await api.post<{
          status: string;
          image: { url: string; mime: string; fileName: string };
        }>(
          "settings/provider/test/image",
          { providerId: draft.id, modelId: requestedModelId },
          { timeout: false },
        );
        const durationMs = Date.now() - started;
        const url = response.image?.url ?? "";
        setImageTestResult({
          url,
          durationMs,
          modelId: requestedModelId,
          prompt: "A red apple on a white background",
        });
        setTestResult(
          t("settings:providers.test_img_done", {
            model: requestedModelId,
            duration: (durationMs / 1000).toFixed(2),
            file: response.image?.fileName ?? "-",
          }),
        );
        onSettings(await api.get<Settings>("settings"));
        toast.success(t("settings:providers.test_img_ok"));
      } catch (error) {
        const message = error instanceof Error ? error.message : t("settings:providers.test_img_failed");
        setTestResult(message);
        toast.error(message);
      } finally {
        setTesting(false);
      }
      return;
    }
    setTestResult(t("settings:providers.test_starting"));
    try {
      await onBeforeTest();
      const response = await fetch(appendWebAuthQuery("/api/settings/provider/test/stream"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ providerId: draft.id, modelId: requestedModelId || undefined }),
      });
      if (!response.ok || !response.body) {
        if (response.status !== 404) {
          const text = await response.text();
          throw new Error(text || `HTTP ${response.status}`);
        }
        const fallback = await api.post<ProviderTestInfo>(
          "settings/provider/test",
          { providerId: draft.id, modelId: requestedModelId || undefined },
          { timeout: false },
        );
        const checks = (fallback.checks ?? [])
          .map(
            (item) =>
              `${item.ok ? "✓" : "×"} ${item.mode}: ${item.status || "failed"}\n${item.preview}`,
          )
          .join("\n\n");
        setTestInfo(fallback);
        setTestChecks(fallback.checks ?? []);
        setTestModelId(fallback.testModelId);
        setTestResult(
          t("settings:providers.test_done_fallback", {
            model: fallback.testModelId,
            endpoint: fallback.endpoint,
            chatEndpoint: fallback.responseApiEndpoint,
            count: fallback.modelCount,
            checks,
            preview: fallback.preview,
          }),
        );
        onSettings(await api.get<Settings>("settings"));
        toast.success(t("settings:providers.test_done_ok"));
        return;
      }
      const checks: ProviderTestCheck[] = [];
      let info: ProviderTestInfo | null = null;
      const renderResult = (prefix = "") => {
        setTestInfo(info);
        setTestChecks([...checks]);
        const header = info
          ? t("settings:providers.test_header", {
              model: info.testModelId || effectiveTestModelId,
              endpoint: info.endpoint,
              chatEndpoint: info.responseApiEndpoint,
              count: info.modelCount,
            })
          : t("settings:providers.test_header_pending", {
              model: effectiveTestModelId || t("settings:providers.auto_selecting"),
            });
        const checkText = checks
          .map(
            (item) =>
              `${item.ok ? "✓" : "×"} ${item.mode}: ${item.status || "failed"}\n${item.preview}`,
          )
          .join("\n\n");
        const preview = info?.preview ? t("settings:providers.test_preview", { preview: info.preview }) : "";
        setTestResult([prefix, header, checkText, preview].filter(Boolean).join("\n\n"));
      };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\n\n+/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const event =
            block
              .split(/\r?\n/)
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim() ?? "message";
          const dataText = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!dataText) continue;
          const data = JSON.parse(dataText) as Record<string, unknown>;
          if (event === "progress") {
            renderResult(String(data.message ?? t("settings:providers.testing")));
          } else if (event === "models") {
            info = data as unknown as ProviderTestInfo;
            if (info.testModelId) setTestModelId(info.testModelId);
            renderResult(t("settings:providers.models_read"));
          } else if (event === "check") {
            checks.push(data as unknown as ProviderTestCheck);
            renderResult(t("settings:providers.test_in_progress"));
          } else if (event === "done") {
            info = data as unknown as ProviderTestInfo;
            if (Array.isArray(info.checks)) checks.splice(0, checks.length, ...info.checks);
            if (info.testModelId) setTestModelId(info.testModelId);
            renderResult(t("settings:providers.test_complete"));
          } else if (event === "error") {
            throw new Error(String(data.error ?? t("settings:providers.test_error")));
          }
        }
      }
      onSettings(await api.get<Settings>("settings"));
      toast.success(t("settings:providers.test_success"));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("settings:providers.test_failed");
      setTestInfo(null);
      setTestChecks([]);
      setTestResult(message);
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsGroup title={t("settings:providers.test_title")} fields>
      {/* 先选模型再测:下拉与「测试」同排,顺序即操作顺序。 */}
      <SettingsRows className="-mt-3">
        <SettingsRow
          label={t("settings:providers.test_model")}
          control={
            <>
              <Select value={effectiveTestModelId} onValueChange={setTestModelId}>
                <SelectTrigger className="w-48 max-w-full" aria-label={t("settings:providers.test_model")}>
                  <SelectValue placeholder={t("settings:providers.test_model_ph")} />
                </SelectTrigger>
                <SelectContent>
                  {mergedTestModels.map((model) => (
                    <SelectItem key={model.id ?? model.modelId} value={model.modelId}>
                      {getModelDisplayName(model.displayName, model.modelId)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="tertiary" size="compact" onClick={() => void test()} disabled={testing}>
                {testing ? <Loader2 className="animate-spin" /> : <Database />}
                {t("settings:providers.test")}
              </Button>
            </>
          }
        />
      </SettingsRows>
      {(testing || testChecks.length > 0 || testInfo) &&
      !isImageTestMode &&
      !imageTestResult ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">{t("settings:providers.test_summary")}</div>
            <div className="text-xs text-[var(--ds-text-secondary)]">
              {testInfo?.testModelId
                ? t("settings:providers.test_summary_model", { model: testInfo.testModelId })
                : testing
                  ? t("settings:providers.testing")
                  : t("settings:providers.awaiting")}
            </div>
          </div>
          <div className="grid gap-2 @xl:grid-cols-3">
            {(["non_stream", "stream", "tools"] as ProviderTestMode[]).map((mode) => {
              const check = testChecks.find((item) => item.mode === mode);
              const pending = testing && !check;
              return (
                <Notice
                  key={mode}
                  tone={check?.ok === true ? "success" : check?.ok === false ? "danger" : "info"}
                  icon={
                    pending ? (
                      <Loader2 className="animate-spin" />
                    ) : check?.ok ? (
                      <CheckCircle2 />
                    ) : check ? (
                      <XCircle />
                    ) : (
                      <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-current opacity-40" />
                    )
                  }
                >
                  <div className="text-sm font-medium">{testModeLabels[mode]}</div>
                  <div className="mt-0.5 text-[var(--ds-text-secondary)]">
                    {check
                      ? check.ok
                        ? t("settings:providers.check_ok", { status: check.status })
                        : t("settings:providers.check_failed", { status: check.status || t("settings:providers.not_connected") })
                      : pending
                        ? t("settings:providers.in_progress")
                        : t("settings:providers.not_tested")}
                  </div>
                </Notice>
              );
            })}
          </div>
        </div>
      ) : null}
      {isImageTestMode && testing && !imageTestResult ? (
        <Notice icon={<Loader2 className="animate-spin" />}>
          {t("settings:providers.img_test_generating_pre")}<span className="font-medium text-[var(--ds-text-primary)]">
            {effectiveTestModelId}
          </span>{" "}
          {t("settings:providers.img_test_generating_post")}
        </Notice>
      ) : null}
      {imageTestResult ? (
        <div className="rounded-[var(--ds-radius-md)] bg-[var(--ds-on-surface)] p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">{t("settings:providers.img_test_result")}</div>
            <div className="text-xs text-[var(--ds-text-secondary)]">
              {t("settings:providers.img_test_model", { model: imageTestResult.modelId, duration: (imageTestResult.durationMs / 1000).toFixed(2) })}
            </div>
          </div>
          <div className="flex flex-wrap items-start gap-3">
            {imageTestResult.url ? (
              <img
                src={appendWebAuthQuery(imageTestResult.url)}
                alt={t("settings:providers.img_alt")}
                className="h-40 w-40 rounded-[var(--ds-radius-sm)] object-cover"
              />
            ) : null}
            <div className="min-w-0 flex-1 text-xs text-[var(--ds-text-secondary)]">
              <div className="mb-1 font-medium text-[var(--ds-text-primary)]">{t("settings:providers.prompt_label")}</div>
              <div className="whitespace-pre-wrap">{imageTestResult.prompt}</div>
            </div>
          </div>
        </div>
      ) : null}
      {testResult ? (
        <pre className="max-h-56 overflow-auto rounded-[var(--ds-radius-md)] bg-[var(--ds-on-surface)] p-3 text-xs whitespace-pre-wrap">
          {testResult}
        </pre>
      ) : null}
    </SettingsGroup>
  );
}
