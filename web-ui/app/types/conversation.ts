import type { UIMessage } from "./message";

/**
 * Message node - container holding one or more candidate messages to support branching.
 * Each node tracks which candidate is selected via `selectIndex`.
 */
export interface MessageNode {
  id: string;
  messages: UIMessage[];
  selectIndex: number;
}

/**
 * A persistent conversation thread between the user and an assistant. The messages form a
 * tree via MessageNode for branching; truncateIndex caps how much history is sent upstream.
 */
export interface Conversation {
  id: string;
  assistantId: string;
  systemPrompt?: string | null;
  title: string;
  messageNodes: MessageNode[];
  truncateIndex: number;
  chatSuggestions: string[];
  isPinned: boolean;
  createAt: number;
  updateAt: number;
}
