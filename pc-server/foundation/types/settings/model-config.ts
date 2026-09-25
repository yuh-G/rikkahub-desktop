export interface ModelConfig {
  favoriteModels: string[];
  chatModelId: string;
  // 快速模型(对齐 APP 2.4.16):标题生成、建议回复等轻量后台任务统一走这一个模型。
  // 取代旧版独立的 titleModelId / suggestionModelId(已被 fastModelId 收敛,见 state-load 回填)。
  fastModelId: string;
  // 快速模型两个子功能的各自开关(默认开)。enableSuggestion 与 APP Settings 数据类同名字段
  // 逐字节对齐(备份双向互通:手机关掉建议,导入 PC 后 PC 也关);titleGenerationEnabled 是
  // PC 先行字段(APP 尚无,导出时 APP 安全忽略,将来可同名对齐)。开关只决定「配了快速模型后
  // 该子功能跑不跑」:标题关 = 退回未配模型的行为(首条消息文本命名),建议关 = 不生成。
  enableSuggestion: boolean;
  titleGenerationEnabled: boolean;
  translateModeId: string;
  imageGenerationModelId: string;
  ocrModelId: string;
  compressModelId: string;
  // 模型 ID,用于对话界面"优化提示词"按钮。空串 = 未配置(按钮会提示去设置页配置)。
  promptOptimizeModelId: string;
  assistantId: string;
}
