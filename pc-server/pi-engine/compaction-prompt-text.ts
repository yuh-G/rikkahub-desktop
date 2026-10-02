// pi 引擎原生压缩 prompt 的展示副本(设置 → 模型 → 场景模型 → 压缩 prompt → 工作区
// 引擎标签页,只读)。
//
// 为什么是副本:vendor 源 (pi/packages/coding-agent/src/core/compaction/compaction.ts)
// 的 SUMMARIZATION_PROMPT 是模块私有常量(未导出),且"pi/ 只跟上游"纪律禁止为展示
// 需求改 vendor 加 export。运行时读 vendor 源文件也不可行(编译后源码不随二进制)。
//
// 漂移防线:compaction-prompt-text.test.ts 在测试期读 vendor 源文件逐字对比,pi 升级
// 改动 prompt 时测试变红,提醒同步本副本。改本文件前先确认 vendor 侧的当前文本。
//
// 展示范围:只展示初次压缩的主 prompt(最能代表"pi 怎么压")。增量更新
// (UPDATE_SUMMARIZATION_PROMPT)与分裂回合前缀摘要(TURN_PREFIX_SUMMARIZATION_PROMPT)
// 是同一机制的变体,不单独展示——前端标签页配说明文案交代这一点。
export const PI_COMPACTION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
