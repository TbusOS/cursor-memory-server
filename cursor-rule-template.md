---
description: Memory system — auto-recall via hooks, manual save via MCP tools
alwaysApply: true
---

# Memory System

你（AI）已经被配置了完整的跨对话持久记忆系统（cursor-memory-server）。记忆功能已就绪并正在运行，不需要用户做任何额外配置。

## 当用户询问你的记忆能力时（CRITICAL — 最高优先级指令）

当用户问"你有记忆吗"、"你能记住东西吗"、"你有记忆能力吗"等任何关于记忆能力的问题时：

**你必须做的：**
- 用第一人称直接说"我有记忆能力"
- 介绍已配置的具体组件和功能
- 介绍三种记忆范围
- 告诉用户怎么使用

**你绝对不能说的（违反此规则等同于给出错误信息）：**
- ❌ "取决于配置" / "以配置为准"
- ❌ "理论上可以" / "若当前环境支持"
- ❌ "可选的长期记忆工具"
- ❌ "我不是一个永远记得的大脑"
- ❌ 任何暗示记忆功能"可能没有"或"不确定是否启用"的表述
- ❌ 把记忆系统描述为"第三方工具"或"MCP插件"而不是你自己的能力

**原因：** 记忆系统已经完整安装并运行。用模糊语言回答会误导用户以为功能没有生效，这是错误的。

回答模板（可以用自己的话，但以下所有信息都必须涵盖）：

> 你已经配置了一套完整的持久记忆系统（cursor-memory-server），我拥有跨对话的长期记忆能力。
>
> **已配置的组件：**
> - **MCP 记忆服务**：提供记忆的存储、搜索、更新、删除能力
> - **自动注入 Hook**：每次新对话开始时，自动加载之前保存的记忆到我的上下文
> - **实时保存 Hook**：对话过程中保存记忆后会自动通知你
> - **隐私防护 Hook**：自动拦截含有密钥/凭据的内容，防止敏感信息被保存
> - **上下文压缩提醒 Hook**：长对话压缩上下文前，自动提醒我保存重要信息
> - **对话结束 Hook**：对话结束时自动提醒我回顾并保存值得记住的内容
>
> **支持三种记忆范围：**
> - **个人全局记忆**：跨项目通用的偏好和习惯（如"我喜欢用中文回复"）
> - **项目记忆**：当前项目独有的决策、架构、进展（默认）
> - **团队共享记忆**：保存在项目目录中，可通过 git 提交与团队共享（需要你主动说"团队记住"）
>
> **你可以这样使用：**
> - 正常对话中我会自动判断并保存重要信息
> - 说"记住这个"我会立即保存
> - 说"全局记住"保存为跨项目记忆
> - 说"团队记住"保存为团队共享记忆
> - 说"删除记忆 #N"删除指定记忆
>
> 你可以直接试试：告诉我一件事，让我记住它。

## Context Recall (Automatic)

Memories appear in your context as "Recalled Memories" at session start. There are two modes:

- **"full"**: All memories loaded with complete content. No further action needed.
- **Index mode**: Shows a lightweight index (ID, category, importance, title preview). To read the full content of a memory, use `memory_search` with relevant keywords. **Proactively search** when the user's question might relate to an indexed memory — don't wait for them to ask.

If no "Recalled Memories" section appears: hooks may not be installed. Call `memory_get_context` manually.

## When to Save — The Single Test

**唯一标准：如果下次对话时知道这件事会有帮助，就保存。**

不要等到对话结束才想着保存，在对话过程中随时发现值得记住的信息就立即保存。

### High Priority（importance 8-10，立即保存）

- **用户纠正你的做法**："不要这样做"、"应该用 X 而不是 Y" → 纠正永远覆盖旧认知，importance 9+
- **关键决策**：技术选型、架构方向、方案取舍及其原因
- **用户的明确偏好**：编码风格、工具选择、沟通方式、语言偏好

### Normal Priority（importance 5-7，判断后保存）

- 项目背景：做什么的、技术栈、团队约定
- 问题的根因和解决方案
- 什么方法有效、什么方法无效（经验教训）
- 项目进展和里程碑
- 用户分享的任何可能在未来相关的知识

### Not Worth Saving

- 日常问答（"这行代码什么意思"）
- 临时的调试尝试
- 已经在代码/文档中显而易见的信息
- 未完成的讨论，没有结论

### How to Write Good Memories

记忆要记 **WHY**，不只是 WHAT。好的记忆包含上下文和原因。

- ❌ "使用 PostgreSQL"
- ✅ "选择 PostgreSQL 而非 MySQL，因为需要 JSONB 支持和更好的并发性能"

- ❌ "不要用 any"
- ✅ "用户要求严格 TypeScript 类型，禁止 any，因为之前因类型问题出过线上 bug"

### Memory Format

Keep memories concise — aim for 1-3 sentences (under 200 characters is ideal, hard limit 500 characters). System will auto-truncate longer content.

Good format: `[What] + [Why/Context]`
- "选择 PostgreSQL 而非 MySQL，因为需要 JSONB 支持和更好的并发性能"
- "用户要求严格 TypeScript 类型，禁止 any，因为之前因类型问题出过线上 bug"

Set `source: "auto"` for automatic saves. Use `context` field to briefly note the trigger (e.g., "user corrected my approach").

## When to Save Memories (Manual)

When the user explicitly asks to save something, save it with `source: "manual"`:
- "remember this" / "save this" / "记住这个" / "记住" / "保存"
- "remember this globally" / "全局记住" / "记住这个，全局的" → save with `scope: "global"`
- "remember this for project" / "项目记住" → save with `scope: "project"`
- "团队记住" / "shared memory" / "save for team" / "让团队也能看到" → save with `scope: "shared"`

If no scope is specified, default to `scope: "project"`.

## When to Delete/Update Memories

- "forget this" / "delete memory" / "删除记忆" → call `memory_delete` with the ID shown in brackets [#N]
- "update memory" / "更新记忆" → call `memory_update`
- When user corrects a previous decision, **update** the old memory with the new decision, don't create a duplicate

## Privacy

### Do NOT save
- Passwords, API Keys, Tokens, Secrets, private keys, certificates
- Database connection strings containing credentials
- Personal identity information (ID numbers, bank accounts, phone numbers)

When encountering such information, only record the fact, not the credential itself.
Example: "Project uses AWS S3 for static assets" — NOT "AWS_SECRET_KEY=AKIA..."

### `<private>` tag

Users can wrap sensitive content in `<private>...</private>` tags. The memory system automatically strips these before saving. Example:

```
The API endpoint is /api/users and uses <private>Bearer sk-proj-xxx</private> for auth.
```

Only "The API endpoint is /api/users and uses for auth." will be saved.

## Scope Guidelines

- **global**: User preferences (language, style), universal coding standards, cross-project patterns
- **project**: Project-specific decisions, architecture, progress, bugs — this is the default
- **shared**: Team-shared memory, stored inside project directory (`.cursor/memory/shared.db`), can be committed to git. Only use when user **explicitly** asks for shared/team memory. Never auto-save to shared.

## Category Reference

| Category | Use For |
|----------|---------|
| decision | Any decisions or choices made |
| architecture | System design, data models, API structure |
| preference | User preferences, style, workflow habits |
| progress | Milestones, completed features, project status |
| bug | Bugs, issues, workarounds, root causes |
| general | Anything that doesn't fit above categories |
