# cursor-memory-server

Cursor IDE 的持久化记忆系统，基于 Skill + Hooks + MCP 三层架构。

## 架构

- **Agent Skill** (`skill/SKILL.md`): AI 行为指引，让 AI 认知记忆为自身技能
- **Hooks** (`src/hooks/`): 5 个自动化 Hook（sessionStart 注入、stop 提醒、preToolUse 隐私防护、postToolUse 通知、preCompact 压缩提醒）
- **MCP Server** (`src/index.ts`): 6 个 MCP 工具，stdio JSON-RPC
- **存储** (`src/store.ts`): SQLite + FTS5，三种 scope（global/project/shared）
- **CLI** (`src/cli.ts`): 导出/导入命令

## 技术栈

- Runtime: Bun（内置 bun:sqlite，原生 TypeScript）
- 存储: SQLite WAL 模式 + FTS5 全文搜索
- 协议: MCP over stdio
- 验证: Zod（MCP SDK 自带）
- 无额外依赖，唯一 npm 依赖是 `@modelcontextprotocol/sdk`

## 开发命令

```bash
bun install                    # 安装依赖
bun run src/index.ts           # 启动 MCP Server
bun run src/cli.ts export      # 导出记忆
bun run src/cli.ts import      # 导入记忆
bash install.sh                # 一键安装（MCP + Skill + Hooks）
```

## 文件结构

- `src/index.ts` — MCP Server 入口，注册 6 个工具
- `src/store.ts` — SQLite 存储层（连接池、FTS5、去重、搜索、迁移、自动清理、隐私过滤）
- `src/types.ts` — TypeScript 类型定义
- `src/hooks/session-start.ts` — sessionStart hook：渐进式记忆注入
- `src/hooks/stop.ts` — stop hook：提醒 AI 保存
- `src/hooks/pre-tool-use.ts` — preToolUse hook：隐私防护，拦截含凭据的记忆
- `src/hooks/post-tool-use.ts` — postToolUse hook：保存/删除/更新后通知用户
- `src/hooks/pre-compact.ts` — preCompact hook：上下文压缩前提醒保存
- `src/cli.ts` — CLI 导出/导入
- `skill/SKILL.md` — Agent Skill：AI 行为指引（替代旧版 Cursor Rule）
- `hooks.json` — Cursor Hooks 配置模板

## 设计原则

- 极简：核心代码 < 500 行
- 零运维：无守护进程，无 HTTP 服务
- 单一数据源：SQLite 是唯一存储
- 渐进式注入：记忆少时全量注入上下文，多时索引 + MCP 搜索
- 冷启动 < 100ms

## 关键设计决策

以下是项目演进过程中做出的重要设计决策，后续开发者请理解这些背景再做修改。

### 1. 为什么选 Skill + Hooks + MCP 三层架构

**决策**：用 Agent Skill 定义 AI 行为（自我认知、保存策略），Hooks 处理自动化（注入、提醒、隐私），MCP 提供数据操作工具。

**原因**：
- 纯 MCP 方案：AI 忘记调工具时记忆不生效，且 AI 把 MCP 工具当"外部插件"而非自身能力
- Cursor Rule (alwaysApply): AI 仍然不认同记忆是自己的能力，实测多次加 CRITICAL 标签、禁用词列表也无效
- Agent Skill: AI 认知为"我的技能"，天然解决自我认知问题。用户可 `/memory` 手动触发，AI 也可自动判断触发

**替代方案被否决**：
- 纯文件方案（markdown 文件 + hooks）：最简单，但无结构化搜索、无去重
- claude-mem 重型方案（HTTP 守护进程 + AI 压缩 + 向量库）：过度工程化

### 2. 渐进式注入策略

**决策**：sessionStart hook 根据记忆数量决定注入策略。≤15 条全量注入，>15 条注入 Top-5 全文 + 其余为轻量索引（40 字符标题）。

**原因**：不存在"模式切换"，是一个连续渐变。MCP Server 始终运行，小项目时所有记忆已在上下文中，零开销。

**可调**：`MEMORY_FULL_THRESHOLD` 环境变量，默认 15。

### 3. stop hook 用 followup_message 而非直接写库

**决策**：stop hook 不直接调 AI API 压缩摘要，而是通过 Cursor 的 `followup_message` 让 AI 自己决定保存什么。

**原因**：AI 在对话中有完整上下文，它对"什么值得保存"的判断远好于外部脚本。零成本，无需额外 AI API 调用。

### 4. 隐私保护是三层防御

**决策**：第一层 Agent Skill 指导 AI 不保存凭据（决策层），第二层 preToolUse Hook 正则拦截（代码层），第三层 `<private>` 标签剥离（数据层）。

**原因**：真正的隐私风险是 AI 自动保存了用户无意间提到的敏感信息。多层防御确保即使一层失效，另一层仍能拦截。

### 5. 三种记忆范围

**决策**：global（跨项目）、project（当前项目，本地）、shared（团队共享，存在项目目录内）。

**原因**：project 使用 Claude Code 风格路径目录名（`/home/user/app` → `home-user-app`），确保每个项目有独立存储。shared 存在项目 `.cursor/memory/shared.db`，可 git 提交与团队共享。shared 仅用户明确要求时使用，从不自动保存。

### 6. 中文搜索用 bigram LIKE，不用外部分词库

**决策**：检测到 CJK 字符时自动切换到 bigram LIKE 搜索。

**原因**：SQLite FTS5 默认 tokenizer 不支持中文分词。在记忆量级（< 10,000 条）下 LIKE 性能足够。

### 7. 数据库迁移机制

**决策**：`schema_version` 表 + 顺序迁移数组，在 `getDb` 打开数据库时自动执行。

**原因**：表结构演进（新增 `context`、`archived` 字段）需要平滑升级路径，无需手动运维。

### 8. 内容长度限制

**决策**：记忆内容最大 1500 字符，超出在句末截断。

**原因**：对话总结需要较大空间来描述一次完整对话的内容。`MAX_MEMORY_LENGTH` 环境变量可调。

### 9. 会话分组（session_id）

**决策**：memories 表新增 `session_id` 列，同一次对话的记忆自动使用相同 session_id（格式 `YYYY-MM-DD-HH`）。

**原因**：同一次对话产生的多条记忆应该关联在一起。下次召回时可以呈现"上次对话讨论了什么"的完整画面，而非碎片化的单条记忆。

### 10. 对话总结类别（conversation）

**决策**：新增 `conversation` 类别，用于保存一次对话的整体总结。session-start hook 会优先展示最近的对话总结。

**原因**：用户最常见的诉求是"上次聊了什么"。对话总结提供快速回答，细节通过 memory_search 按需查看。

### 11. Rule + Skill 双层（AI 自我认知）

**决策**：最小 alwaysApply Rule 确保 AI 始终知道自己有记忆能力，详细操作指南放在 Skill 中按需加载。

**原因**：纯 Skill 方案下，AI 不一定每次都加载 Skill 指令，导致有时回答"不确定有没有记忆"。alwaysApply Rule 保证自我认知始终存在。

## 与 claude-mem 的对比

| 维度 | cursor-memory-server | claude-mem |
|------|---------------------|------------|
| 核心代码 | ~500 行 | 数万行 |
| 额外进程 | 无 | HTTP 守护进程 + MCP 子进程 + Chroma |
| 存储 | SQLite（单一） | SQLite + Chroma 向量库 |
| AI 压缩 | 不需要（AI 自己在对话中摘要） | 每次 observation 都要 AI API 压缩 |
| 运行时 | Bun | Bun + Node.js + uv(Python) |

本项目追求的是**用最少的代码解决 80% 的问题**，而非追求功能完备。
