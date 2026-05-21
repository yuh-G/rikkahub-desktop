import type { AssistantProfile } from "~/types";

type AffectScope = "USER" | "ASSISTANT";

function regexScopes(value: unknown): Set<AffectScope> {
  const items = Array.isArray(value) ? value.map(String) : [];
  return new Set(items.map((item) => item.toUpperCase()).filter((item): item is AffectScope => item === "USER" || item === "ASSISTANT"));
}

export function applyAssistantRegexes(
  text: string,
  assistant: AssistantProfile | null | undefined,
  scope: AffectScope,
  visual: boolean,
) {
  if (!assistant || !Array.isArray(assistant.regexes) || assistant.regexes.length === 0) {
    return text;
  }

  return assistant.regexes.reduce((current, regex) => {
    if (!regex || typeof regex !== "object" || Array.isArray(regex)) return current;
    if (regex.enabled === false || regex.visualOnly !== visual || !regexScopes(regex.affectingScope).has(scope)) {
      return current;
    }

    const findRegex = String(regex.findRegex ?? "").trim();
    if (!findRegex) return current;

    try {
      return current.replace(new RegExp(findRegex, "g"), String(regex.replaceString ?? ""));
    } catch {
      return current;
    }
  }, text);
}
