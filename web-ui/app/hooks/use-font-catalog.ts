import { useQuery, useQueryClient } from "@tanstack/react-query";

import api from "~/services/api";
import type { FontCatalog } from "~/types/font";

// 字体目录查询。staleTime=Infinity:字体增删频率极低,上传/删除后由调用方显式 invalidate。
export const FONT_CATALOG_QUERY_KEY = ["fonts", "catalog"] as const;

export function useFontCatalog() {
  return useQuery({
    queryKey: FONT_CATALOG_QUERY_KEY,
    queryFn: () => api.get<FontCatalog>("fonts/list"),
    staleTime: Infinity,
  });
}

export function useInvalidateFontCatalog() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: FONT_CATALOG_QUERY_KEY });
}
