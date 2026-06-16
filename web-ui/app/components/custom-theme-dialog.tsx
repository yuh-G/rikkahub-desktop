import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import type { CustomThemeCss, UserTheme } from "~/components/theme-provider";

const CUSTOM_THEME_EDITOR_ROWS = 14;

function mergeThemeCss(light: string, dark: string): string {
  if (light && dark) {
    return `${light}\n\n${dark}`;
  }

  return light || dark || "";
}

type CustomThemeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  editing?: UserTheme | null;
  onSave: (data: { name: string; css: CustomThemeCss }) => void;
};

export function CustomThemeDialog({
  open,
  onOpenChange,
  mode,
  editing,
  onSave,
}: CustomThemeDialogProps) {
  const { t } = useTranslation();
  const [nameDraft, setNameDraft] = React.useState("");
  const [cssDraft, setCssDraft] = React.useState("");
  const [nameError, setNameError] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    setNameDraft(editing?.name ?? "");
    setCssDraft(editing ? mergeThemeCss(editing.css.light, editing.css.dark) : "");
    setNameError(false);
  }, [editing, open]);

  const handleSave = () => {
    const name = nameDraft.trim();
    if (!name) {
      setNameError(true);
      return;
    }

    let lightCss = cssDraft.match(/:root\s*\{[\s\S]*?\}/)?.[0]?.trim() ?? "";
    let darkCss =
      cssDraft.match(/(?:\.dark|:root\.dark)\s*\{[\s\S]*?\}/)?.[0]?.trim() ?? "";

    if (!lightCss && !darkCss && cssDraft.trim()) {
      lightCss = cssDraft.trim();
    }

    onSave({ name, css: { light: lightCss, dark: darkCss } });
    onOpenChange(false);
  };

  const isCreate = mode === "create";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t(`custom_theme_dialog.${isCreate ? "create_title" : "edit_title"}`)}
          </DialogTitle>
          <DialogDescription>{t("custom_theme_dialog.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="text-sm font-medium">{t("custom_theme_dialog.name_label")}</div>
            <Input
              value={nameDraft}
              onChange={(event) => {
                setNameDraft(event.target.value);
                if (nameError) {
                  setNameError(false);
                }
              }}
              placeholder={t("custom_theme_dialog.name_placeholder")}
              aria-invalid={nameError}
            />
            {nameError ? (
              <p className="text-xs text-destructive">{t("custom_theme_dialog.name_required")}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium">{t("custom_theme_dialog.theme_variables")}</div>
            <Textarea
              value={cssDraft}
              onChange={(event) => {
                setCssDraft(event.target.value);
              }}
              placeholder={t("custom_theme_dialog.theme_placeholder")}
              rows={CUSTOM_THEME_EDITOR_ROWS}
              className="field-sizing-fixed h-56 max-h-56 overflow-y-auto font-mono text-xs"
            />
          </div>

          <div className="text-sm text-muted-foreground">
            {t("custom_theme_dialog.tip")}{" "}
            <a
              href="https://tweakcn.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              https://tweakcn.com/
            </a>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t("custom_theme_dialog.cancel")}
          </Button>
          <Button type="button" onClick={handleSave}>
            {t(`custom_theme_dialog.${isCreate ? "create_and_apply" : "save"}`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
