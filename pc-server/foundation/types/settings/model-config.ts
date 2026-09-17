export interface ModelConfig {
  favoriteModels: string[];
  chatModelId: string;
  // 快速模型(对齐 APP 2.4.16):标题生成、建议回复等轻量后台任务统一走这一个模型。
  // 取代旧版独立的 titleModelId / suggestionModelId(已被 fastModelId 收敛,见 state-load 回填)。
  fastModelId: string;
  translateModeId: string;
  imageGenerationModelId: string;
  ocrModelId: string;
  compressModelId: string;
  // 模型 ID,用于对话界面"优化提示词"按钮。空串 = 未配置(按钮会提示去设置页配置)。
  promptOptimizeModelId: string;
  assistantId: string;
}
