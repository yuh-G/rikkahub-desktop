// P0→P2 冒烟脚本(P7 更新为统一会话数据):验证 vendored pi 引擎经我们的完整链路可用:
// 我们的 provider 配置 → model-bridge 映射(P1) → runner 驱动会话(P7:DB 历史灌注进
// inMemory SessionManager + 事件桥) → GenerationEvent → 生产同款应用器写 Message.parts。
// 假模型 = 本地 http mock(test-utils/fake-openai-sse,SSE 格式抄 pi 自家测试)。
// 运行: cd pc-server && bun scripts/pi-spike.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 数据目录沙箱必须在任何业务模块 import 之前钉死(paths.ts 首次 import 即固化)。
const spikeDataDir = mkdtempSync(join(tmpdir(), "pi-spike-data-"));
process.env.RIKKAHUB_PC_DATA_DIR = spikeDataDir;

const { message } = await import("../foundation/utils");
const { model, provider } = await import("../model-providers");
const { createGenerationEventApplier } = await import("../conversations/generation-apply");
const { runPiGeneration } = await import("../pi-engine/runner");
const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");

const SPIKE_PROVIDER_ID = "00000000-0000-4000-8000-000000000001";
const FAKE_REPLY = "hello from fake model";

async function main(): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-spike-cwd-"));
	const server = await startFakeOpenAiSse([
		{ content: FAKE_REPLY, usage: { prompt_tokens: 7, completion_tokens: 5 } },
		{ content: "second turn reply", usage: { prompt_tokens: 21, completion_tokens: 4 } },
	]);

	try {
		const ourProvider = provider({
			id: SPIKE_PROVIDER_ID,
			name: "Spike Provider",
			baseUrl: server.baseUrl,
			apiKey: "sk-spike-fake",
		});
		const ourModel = model("fake-model", "Spike Fake Model");

		// 我们会话模型里的一轮生成目标(生产由 generateAnswer 构造,冒烟自构同形)。
		const assistantMessage = message("ASSISTANT", [], ourModel.id);
		assistantMessage.parts = [{ type: "loading", label: "正在生成回复" }];
		const node = { id: "spike-node", messages: [assistantMessage], selectIndex: 0 };
		const conversation = {
			id: "spike-conv",
			assistantId: "spike-assistant",
			systemPrompt: null,
			title: "",
			messages: [node],
			chatSuggestions: [],
			isPinned: false,
			createAt: Date.now(),
			updateAt: Date.now(),
		};
		const apply = createGenerationEventApplier({ conversation, node, message: assistantMessage });

		const first = await runPiGeneration({
			provider: ourProvider,
			model: ourModel,
			conversationId: conversation.id,
			cwd,
			history: [],
			promptText: "Say hello",
			sink: apply,
		});
		console.log("[pi-spike] turn1 text:", JSON.stringify(first.text), "degraded:", first.degradedMessageIds);
		console.log("[pi-spike] turn1 parts:", JSON.stringify(assistantMessage.parts));
		console.log("[pi-spike] turn1 usage:", JSON.stringify(assistantMessage.usage));

		if (first.text !== FAKE_REPLY) throw new Error("turn1 文本未闭环");
		if (first.capturedCompactions.length) throw new Error("turn1 不应产生压缩记录");
		const textPart = assistantMessage.parts.find((part) => part.type === "text");
		if (!textPart || (textPart as { text?: string }).text !== FAKE_REPLY) throw new Error("part 序列未写入正文");
		if (assistantMessage.parts.some((part) => part.type === "loading")) throw new Error("loading 占位未被剥离");
		if (!assistantMessage.usage) throw new Error("usage 未合并");

		// 第二轮:P7 语义——上一轮问答作为 history 灌注(生产侧由 generateAnswer 从
		// 选中路径构建),灌注的历史必须回放给上游(DB 单一事实源的硬证据)。
		const user1 = message("USER", [{ type: "text", text: "Say hello" }]);
		const asst1 = message("ASSISTANT", [{ type: "text", text: FAKE_REPLY }]);
		const second = await runPiGeneration({
			provider: ourProvider,
			model: ourModel,
			conversationId: conversation.id,
			cwd,
			history: [user1, asst1],
			promptText: "And again",
			sink: apply,
		});
		console.log("[pi-spike] turn2 text:", JSON.stringify(second.text));
		const secondRequest = server.requests[1] as { messages?: unknown[] };
		const replay = JSON.stringify(secondRequest?.messages ?? []);
		if (!replay.includes(FAKE_REPLY) || !replay.includes("Say hello") || !replay.includes("And again")) {
			throw new Error("turn2 上游请求未携带灌注的第一轮上下文");
		}

		console.log("[pi-spike] PASS: 配置→映射→runner(P7 历史灌注)→事件桥→应用器→parts 全链路闭环 + DB 历史回放");
	} finally {
		await server.close();
		rmSync(spikeDataDir, { recursive: true, force: true });
	}
}

await main();
process.exit(0);
