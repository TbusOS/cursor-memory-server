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
- `src/store.ts` — SQLite 存储层（连接池、FTS5、去重、搜索）
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
