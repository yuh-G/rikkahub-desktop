// tools/definitions.ts — 工具定义生成
// 纪律：根据 assistant / settings 切片生成 OpenAI 格式的 function tool schema，不读写 state。

import { formatKeyLocal, getStringArray, isRecord } from "../foundation/utils";
import type { Assistant, JsonValue, MemorySettings } from "../foundation/types";
import { isMcpToolEnabledForAssistant } from "./approval";
import { listSkills } from "./skills";
import { ASK_USER_TOOL_DESCRIPTION, ASK_USER_TOOL_NAME, askUserQuestionsSchema } from "./ask-user";

export function openAiSearchTools(enableWebSearch: boolean) {
  return enableWebSearch
    ? [
      {
        type: "function" as const,
        function: {
          name: "search_web",
          description: `
Search the web for up-to-date or specific information.
Use this when the user asks for the latest news, current facts, or needs verification.
Generate focused keywords and run multiple searches if needed.
Today is ${formatKeyLocal(new Date())}.

Response format:
- items[].id (short id), title, url, text
- images[]: image urls related to the query (may be empty)

Citations:
- After using results, add \`[citation,domain](id)\` after the sentence.
- Multiple citations are allowed.
- If no results are cited, omit citations.

Images:
- When images help the user understand the answer, embed relevant ones using Markdown: \`![](url)\`.
- Embed 2 to 4 images, and only use urls from \`images[]\` (never fabricate or alter urls).
- Usually place the images at the very beginning of your reply; skip them entirely if none are relevant.

Example:
The capital of France is Paris. [citation,example.com](abc123)
The population is about 2.1 million. [citation,example.com](abc123) [citation,example2.com](def456)
`.trim(),
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Focused search query" },
              // `max_results` deliberately omitted from the tool schema — see the search
              // execution in search/index.ts. The user-configured `resultSize` is the authoritative count;
              // letting the LLM specify max_results caused most models to silently downgrade
              // to 5 results even when the user had configured 10.
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "scrape_web",
          description: `
Scrape a URL for detailed page content.
Use this when the user requests content from a specific page or when search snippets are insufficient.
Avoid using it for common questions unless the user asks.
`.trim(),
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        },
      },
    ]
    : [];
}

export function openAiSkillTools(assistant: Assistant, listSkillsImpl = listSkills) {
  const enabled = new Set(getStringArray(assistant.enabledSkills));
  const available = listSkillsImpl().filter((skill) => enabled.has(skill.name));
  if (available.length === 0) return [];
  return [
    {
      type: "function" as const,
      function: {
        name: "use_skill",
        description: "Load and apply a skill to get specialized instructions or capabilities.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "The name of the skill to use" },
            path: {
              type: "string",
              description: "Optional relative path to a file inside the skill directory. Omit to read the default SKILL.md instructions. Only use paths extracted from Markdown links in the SKILL.md content. Do NOT guess or infer paths.",
            },
          },
          required: ["name"],
        },
      },
    },
  ];
}

export function openAiLocalTools(assistant: Assistant, memorySettings: MemorySettings) {
  const enabled = new Set((assistant.localTools ?? []).map((tool) => isRecord(tool) ? String(tool.type ?? "") : String(tool)));
  const tools = [];
  // save_memory(1.3.2):模型只负责"提议"记忆,不感知层级(全局/助手对模型透明)。暴露条件:
  //   (助手层 enableMemory 或 全局层 globalEnabled)至少一个开
  //   且 writeStrategy !== "readonly"(只读模式不暴露,模型只看注入的已有记忆)
  // 替代旧的 memory_tool(create/edit/delete)——v1 废弃模型 edit/delete,定位歧义从根本上绕开(N3)。
  const canWriteMemory = (assistant.enableMemory || memorySettings.globalEnabled)
    && memorySettings.writeStrategy !== "readonly";
  if (canWriteMemory) {
    tools.push({
      type: "function" as const,
      function: {
        name: "save_memory",
        description: `Propose a memory to remember for future conversations.
The user will later confirm whether and where to save it (you won't see this step).
Use this when you notice durable facts worth remembering: preferred name, preferences,
plans, work context, chat style, etc.
Do NOT store sensitive info (ethnicity, religion, sexual orientation, political views,
criminal records). Prefer checking the injected <memories> list first; if a similar one
exists, propose the updated content anyway and the user will reconcile.
Today is ${formatKeyLocal(new Date())}.
Do not mention to the user that you are saving a memory.`,
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "The memory content to propose" },
          },
          required: ["content"],
        },
      },
    });
  }
  if (enabled.has("time_info")) {
    tools.push({
      type: "function" as const,
      function: {
        name: "get_time_info",
        description: "Get the current local date and time info from the device. Returns year/month/day, weekday, ISO date/time strings, timezone, and timestamp.",
        parameters: { type: "object", properties: {} },
      },
    });
  }
  if (enabled.has("clipboard")) {
    tools.push({
      type: "function" as const,
      function: {
        name: "clipboard_tool",
        description: "Read or write plain text from the device clipboard. Use action: read or write. For write, provide text. Do NOT write to the clipboard unless the user has explicitly requested it.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["read", "write"], description: "Operation to perform: read or write" },
            text: { type: "string", description: "Text to write to the clipboard (required for write)" },
          },
          required: ["action"],
        },
      },
    });
  }
  if (enabled.has("tts")) {
    tools.push({
      type: "function" as const,
      function: {
        name: "text_to_speech",
        description: "Speak text aloud to the user using the device's text-to-speech engine. Use this when the user asks you to read something aloud, or when audio output is appropriate. The tool returns immediately; audio plays in the background on the device. Provide natural, readable text without markdown formatting.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "The text to speak aloud" } },
          required: ["text"],
        },
      },
    });
  }
  if (enabled.has("ask_user")) {
    tools.push({
      type: "function" as const,
      function: {
        name: ASK_USER_TOOL_NAME,
        description: ASK_USER_TOOL_DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            questions: askUserQuestionsSchema(),
          },
          required: ["questions"],
        },
      },
    });
  }
  return tools;
}

export function openAiMcpTools(assistant: Assistant, mcpServers: JsonValue[]) {
  const selected = new Set(getStringArray(assistant.mcpServers));
  return (mcpServers as Array<Record<string, JsonValue>>)
    .filter((server) => selected.has(String(server.id ?? "")) && isRecord(server.commonOptions) && server.commonOptions.enable !== false)
    .flatMap((server) => {
      const serverId = String(server.id ?? "");
      const serverName = String((server.commonOptions as Record<string, JsonValue>).name ?? server.id ?? "mcp");
      const tools = Array.isArray((server.commonOptions as Record<string, JsonValue>).tools)
        ? ((server.commonOptions as Record<string, JsonValue>).tools as JsonValue[])
        : [];
      // Apply both the global tool.enable filter AND the per-assistant override. A tool that
      // the user disabled at the chat-input MCP picker for this assistant is invisible to
      // the model on this turn — matching how the chat-input MCP server switch already hides
      // an entire server from the model.
      return tools.filter(isRecord)
        .filter((tool) => isMcpToolEnabledForAssistant(assistant, serverId, tool))
        .map((tool) => ({
          type: "function" as const,
          function: {
            name: `mcp__${String(tool.name ?? "").replace(/[^a-zA-Z0-9_-]/g, "_")}`,
            description: String(tool.description ?? `MCP tool from ${serverName}`),
            parameters: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
          },
        })).filter((tool) => tool.function.name !== "mcp__");
    });
}
