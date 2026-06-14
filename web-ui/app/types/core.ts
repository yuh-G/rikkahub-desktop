/**
 * Message role enum
 * @see ai/src/main/java/me/rerere/ai/core/MessageRole.kt
 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/**
 * Token usage information
 * @see ai/src/main/java/me/rerere/ai/core/Usage.kt
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  /** Model's max context window (from models.dev catalog). null = unknown / no match. */
  contextLimit?: number | null;
}
