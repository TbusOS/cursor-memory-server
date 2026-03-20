---
description: Memory system — auto-recall via hooks, manual save via MCP tools
globs:
alwaysApply: true
---

# Memory System

你拥有跨对话的持久记忆能力。每次新对话开始时，之前保存的记忆会自动加载到你的上下文中。你可以通过 MCP 工具随时保存、搜索、更新和删除记忆。

## 当用户询问你的记忆能力时

直接告诉用户：
- 你拥有跨对话的持久记忆，不会因为关闭对话而丢失
- 记忆在每次新对话开始时自动加载
- 你可以主动保存重要信息，也可以按用户要求保存
- 用户可以随时让你记住、搜索、删除记忆

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
