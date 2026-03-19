# cursor-memory-server

Cursor IDE 的持久化记忆系统，基于 Hooks + MCP 混合架构。

## 架构

- **Hooks** (`src/hooks/`): sessionStart 自动注入记忆，stop 提醒保存
- **MCP Server** (`src/index.ts`): 6 个 MCP 工具，stdio JSON-RPC
- **存储** (`src/store.ts`): SQLite + FTS5，双数据库（global.db + project/*.db）
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
bash install.sh all <path>     # 一键安装（MCP + Hooks + Rules）
```

## 文件结构

- `src/index.ts` — MCP Server 入口，注册 6 个工具
- `src/store.ts` — SQLite 存储层（连接池、FTS5、去重、搜索、迁移、自动清理、隐私过滤）
- `src/types.ts` — TypeScript 类型定义
- `src/hooks/session-start.ts` — sessionStart hook：动态记忆注入
- `src/hooks/stop.ts` — stop hook：提醒 AI 保存
- `src/cli.ts` — CLI 导出/导入
- `hooks.json` — Cursor Hooks 配置模板
- `cursor-rule-template.md` — Cursor Rule 行为指引模板

## 设计原则

- 极简：核心代码 < 500 行
- 零运维：无守护进程，无 HTTP 服务
- 单一数据源：SQLite 是唯一存储
- 动态注入：记忆少时全量注入上下文，多时部分注入 + MCP 搜索
- 冷启动 < 100ms

## 关键设计决策

以下是项目演进过程中做出的重要设计决策，后续开发者请理解这些背景再做修改。

### 1. 为什么选 Hooks + MCP 混合架构，而不是纯 MCP

**决策**：用 Cursor Hooks（v1.7+）处理自动化（记忆注入和保存提醒），MCP 作为大数据量下的搜索后备。

**原因**：纯 MCP 方案依赖 AI 主动调用 `memory_get_context`，实测 AI 经常忘记调用，导致记忆形同虚设。Hooks 在 sessionStart 时自动注入，100% 可靠。

**替代方案被否决**：
- 纯文件方案（markdown 文件 + hooks）：最简单，但无结构化搜索、无去重、记忆多时无法管理
- 纯 MCP 方案（当前代码现状）：AI 忘记调工具时记忆不生效
- claude-mem 重型方案（HTTP 守护进程 + AI 压缩 + 向量库）：过度工程化，数万行代码解决简单问题

### 2. 动态注入策略：渐变而非切换

**决策**：sessionStart hook 根据记忆数量决定注入策略。≤50 条全量注入，>50 条注入 Top-20 + 提示用 MCP 搜索。

**原因**：不存在"模式切换"，是一个连续渐变。MCP Server 始终运行，小项目时 AI 自然不会调用它（因为所有记忆已在上下文中），零开销。阈值 50 条 ≈ 2,500 token，可接受。

**可调**：`MEMORY_THRESHOLD` 环境变量，默认 50。

### 3. stop hook 用 followup_message 而非直接写库

**决策**：stop hook 不直接调 AI API 压缩摘要，而是通过 Cursor 的 `followup_message` 让 AI 自己决定保存什么。

**原因**：AI 在对话中有完整上下文，它对"什么值得保存"的判断远好于外部脚本。不需要额外 AI API 调用（零成本），不需要常驻 Worker 进程。

### 4. 导出/导入是 CLI 命令，不是 MCP 工具

**决策**：`src/cli.ts` 提供 export/import 命令行工具，不做成 MCP 工具。

**原因**：导出/导入是运维操作。做成 MCP 工具意味着 AI 能批量写入任意内容（安全风险），且导出结果打进上下文窗口浪费 token。

### 5. 自动清理在 initDb 执行，不是 MCP 工具

**决策**：低重要性过期记忆在数据库打开时自动清理。

**原因**：AI 不应该有批量删除用户记忆的权限。清理策略固定（importance ≤ 2 且 90 天、importance ≤ 4 且 180 天），无需人工判断。

### 6. 隐私保护是双层防御

**决策**：第一层 Cursor Rule 指导 AI 不保存凭据（主防线），第二层代码剥离 `<private>` 标签（补充）。

**原因**：真正的隐私风险是 AI 自动保存了用户无意间提到的敏感信息，这不是用户能预见并标记的。Cursor Rule 比代码过滤更有效——它在信息产生的源头（AI 决策层）拦截。

### 7. 中文搜索用 bigram LIKE，不用外部分词库

**决策**：检测到 CJK 字符时自动切换到 bigram LIKE 搜索，不引入 jieba 等分词库。

**原因**：SQLite FTS5 默认 tokenizer 不支持中文分词。引入外部分词库会破坏"零依赖"原则。在记忆量级（< 10,000 条）下 LIKE 性能足够。

### 8. contentOverlap 去重用 extractKeywords

**决策**：`contentOverlap` 复用 `extractKeywords` 函数（含 bigram 分词），而非 `split(/\s+/)`。

**原因**：`split(/\s+/)` 无法处理中文——整句被当作一个 token，去重完全失效。`extractKeywords` 已实现 CJK bigram 分词，直接复用。

### 9. 数据库迁移机制

**决策**：`schema_version` 表 + 顺序迁移数组，在 `getDb` 打开数据库时自动执行。

**原因**：表结构演进（如新增 `context`、`archived` 字段）需要平滑升级路径。迁移在数据库打开时自动执行，无需手动运维。

## 已完成功能

详见 `docs/improvement-plan.md` 的设计文档。所有功能已实现：

```
Phase 1 - Bug 修复
├── P0-1: ✅ 中文去重修复（contentOverlap 使用 extractKeywords）
└── P0-2: ✅ scope="both" limit 语义修复（合并后截断）

Phase 2 - 核心功能
├── P1-1: ✅ CLI 导出/导入（src/cli.ts）
├── P1-2: ✅ 隐私双层防御（stripPrivateTags + Cursor Rule）
└── P1-3: ✅ Hooks 自动记忆（session-start.ts + stop.ts）

Phase 3 - 可维护性
├── P2-1: ✅ 数据库迁移机制（schema_version 表）
├── P2-2: ✅ 记忆自动清理（getDb 时执行）
└── P2-3: ✅ 项目名检测增强（向上查找 .git 等标志）

Phase 4 - 增强功能
├── P3-1: ✅ 记忆关联上下文字段（context 列，搜索时展示）
└── P3-2: ✅ 全局一键安装（install.sh global 安装 MCP + Hooks + Rules）
```

## 与 claude-mem 的对比

本项目的设计明确区别于 claude-mem（另一个记忆系统）：

| 维度 | cursor-memory-server | claude-mem |
|------|---------------------|------------|
| 核心代码 | ~500 行 | 数万行 |
| 额外进程 | 无 | HTTP 守护进程 + MCP 子进程 + Chroma |
| 存储 | SQLite（单一） | SQLite + Chroma 向量库 |
| AI 压缩 | 不需要（AI 自己在对话中摘要） | 每次 observation 都要 AI API 压缩 |
| 运行时 | Bun | Bun + Node.js + uv(Python) |

本项目追求的是**用最少的代码解决 80% 的问题**，而非追求功能完备。
