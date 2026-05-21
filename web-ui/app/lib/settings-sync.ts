import api from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import type { Settings } from "~/types";

export async function refreshSettingsStore(): Promise<Settings> {
  const settings = await api.get<Settings>("settings");
  useSettingsStore.getState().setSettings(settings);
  return settings;
}
