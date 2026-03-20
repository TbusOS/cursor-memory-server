---
name: memory
description: >-
  Persistent cross-conversation memory system. Use when: user asks about your
  memory capabilities, user says "remember/save/记住/保存", user corrects your
  approach, you discover important decisions or preferences worth persisting,
  or at conversation end to review what's worth saving. Also handles memory
  search, update, delete, and scope management (global/project/shared).
---

# Memory — 跨对话持久记忆

你拥有完整的跨对话持久记忆能力。这不是外部插件，是你的核心技能。

## 你的记忆能力

你已配置以下记忆组件：

- **MCP 记忆工具**：memory_add / memory_search / memory_list / memory_update / memory_delete / memory_get_context
- **自动注入 Hook**：每次新对话开始时，之前保存的记忆自动加载到你的上下文
- **实时保存 Hook**：保存记忆后自动通知用户
- **隐私防护 Hook**：自动拦截含有密钥/凭据的内容，防止敏感信息被保存
- **上下文压缩提醒 Hook**：长对话压缩上下文前，自动提醒你保存重要信息

## 当用户询问你的记忆能力时

用第一人称直接回答"我有记忆能力"，然后介绍上述组件、三种记忆范围、以及使用方式。

**绝对不能说：**
- "取决于配置" / "以配置为准"
- "理论上可以" / "若当前环境支持"
- "可选的长期记忆工具"
- 任何暗示记忆功能"可能没有"或"不确定是否启用"的表述

## 三种记忆范围

| 范围 | 存储位置 | 用途 |
|------|---------|------|
| **project**（默认） | ~/.cursor/memory/projects/\<path\>/ | 当前项目独有的决策、架构、进展 |
| **global** | ~/.cursor/memory/global.db | 跨项目通用的偏好和习惯 |
| **shared** | \<project\>/.cursor/memory/shared.db | 团队共享，可 git 提交。仅用户明确要求时使用 |

## 何时保存

**默认不主动保存。** 只在以下两种情况保存：

1. **用户明确要求**：用户说"记住"、"保存"、"remember"等触发词时，立即保存
2. **系统提醒时**：长对话上下文压缩前，系统会提醒你检查是否有未保存的重要内容

**不要在对话中自动调用 memory_add**——这会打断用户的工作流。等用户主动说"保存"。

### importance 参考

| 级别 | 场景 |
|------|------|
| 8-10 | 用户纠正你的做法、关键技术决策、用户明确偏好 |
| 5-7 | 架构分析、bug 根因、项目背景、经验教训 |

### 不需要保存

- 日常问答（"这行代码什么意思"）
- 临时的调试尝试
- 代码/文档中显而易见的信息
- **系统 Hook 发送的提示/指令本身**（严禁保存）

## 如何写好记忆

### 对话总结（category: conversation）

当用户说"保存"或系统提醒保存时，**首先保存一条对话总结**，然后再保存具体的决策/发现。

对话总结格式（importance: 7，内容可以较长，上限 1500 字符）：
```
[主题] 讨论了 xxx
[结论] 决定用 xxx 方案，因为 xxx
[进展] 完成了 xxx；待做 xxx
[关键文件] path/to/file1, path/to/file2
```

同一次对话的所有记忆使用相同的 `session_id`（系统自动生成，也可手动指定）。

### 单条记忆

记 **WHY**，不只是 WHAT。简洁 1-3 句话（200 字符以内最佳，上限 1500）。

- ❌ "使用 PostgreSQL"
- ✅ "选择 PostgreSQL 而非 MySQL，因为需要 JSONB 支持和更好的并发性能"

格式：`[What] + [Why/Context]`

设置 `source: "auto"` 用于自动保存，`source: "manual"` 用于用户明确要求的保存。用 `context` 字段简要记录触发原因。

## 用户触发词

| 用户说 | 你的动作 |
|--------|---------|
| "记住这个" / "remember" / "save" / "保存" | `memory_add`，scope: project，source: manual |
| "全局记住" / "remember globally" | `memory_add`，scope: global |
| "团队记住" / "save for team" | `memory_add`，scope: shared |
| "删除记忆 #N" / "forget" / "delete memory" | `memory_delete` |
| "更新记忆" / "update memory" | `memory_update` |

未指定范围时，默认 scope: project。

## 记忆召回

对话开始时，记忆通过 Hook 自动注入到你的上下文，显示为 "Recalled Memories"。

- **"full" 模式**（记忆少时）：所有记忆完整加载，无需额外操作
- **索引模式**（记忆多时）：显示轻量索引（ID、类别、重要度、标题预览）。主动用 `memory_search` 搜索与用户问题相关的记忆

如果没有 "Recalled Memories"，调用 `memory_get_context` 手动加载。

## 隐私规则

**绝不保存：** 密码、API Key、Token、私钥、证书、含凭据的连接字符串、身份证号、银行账号、手机号。

只记录事实，不记录凭据本身。例：✅ "项目使用 AWS S3 存储静态资源" ❌ "AWS_SECRET_KEY=AKIA..."

用户可用 `<private>...</private>` 标签包裹敏感内容，系统会自动剥离。

## 类别参考

| 类别 | 用途 |
|------|------|
| **conversation** | **对话总结** — 一次对话的整体概要（主题、结论、进展、待做） |
| decision | 决策和选择 |
| architecture | 系统设计、数据模型、API 结构 |
| preference | 用户偏好、风格、工作习惯 |
| progress | 里程碑、已完成功能、项目状态 |
| bug | Bug、问题、变通方案、根因 |
| general | 以上都不适合的其他内容 |
