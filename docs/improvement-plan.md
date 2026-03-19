# cursor-memory-server 改进方案

> 基于 claude-mem 设计分析、Cursor Hooks 系统调研，结合 cursor-memory-server 自身现状，提出以下改进方案。
>
> 设计原则：保持极简风格，不引入新依赖，冷启动 < 100ms，SQLite 为唯一数据源。

---

## 架构演进：Hooks + MCP 动态融合

### 现状

当前系统完全依赖 AI 主动调用 MCP 工具：AI 手动调 `memory_get_context` 召回记忆，对话中主动调 `memory_add` 保存。这导致两个问题：

1. **召回不可靠**：AI 经常忘记在对话开始时调 `memory_get_context`
2. **保存不可靠**：AI 对"什么值得保存"的判断不稳定，关键决策可能被遗漏

### 目标架构

引入 Cursor Hooks（v1.7+）实现自动化，同时保留 MCP 作为大数据量下的搜索后备：

```
┌──────────────────────────────────────────────────────┐
│                     Cursor IDE                        │
│                                                       │
│  sessionStart hook                                    │
│  ┌─────────────────────────────────────────────────┐  │
│  │ count = SELECT COUNT(*) FROM memories           │  │
│  │                                                 │  │
│  │ if count ≤ THRESHOLD:                           │  │
│  │   → 全量注入 additional_context                 │  │
│  │   → AI 不需要调 MCP 搜索                        │  │
│  │                                                 │  │
│  │ if count > THRESHOLD:                           │  │
│  │   → 注入 Top-N (importance × recency)          │  │
│  │   → 提示 AI 用 memory_search 查更多             │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  stop hook                                            │
│  ┌─────────────────────────────────────────────────┐  │
│  │ → followup_message 提醒 AI 保存记忆             │  │
│  │ → AI 自行判断并调 memory_add                    │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  MCP Server (stdio, always available)                 │
│  ┌─────────────────────────────────────────────────┐  │
│  │ memory_add / memory_search / memory_delete ...  │  │
│  │ (小模式下不被调用，零开销)                        │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│              SQLite (单一数据源)                       │
│              ~/.cursor/memory/                         │
└──────────────────────────────────────────────────────┘
```

**关键设计决策：渐变而非切换。** MCP Server 始终运行，Hook 始终运行。唯一的区别是 sessionStart 注入的内容量——记忆少时全量注入（AI 不需要 MCP），记忆多时部分注入 + 提示用 MCP 搜索。体验是连续的，不存在模式切换。

---

## P0-1：中文去重修复（Bug 修复）

### 问题

`contentOverlap` 函数使用 `split(/\s+/)` 按空格分词计算 Dice 系数。中文文本没有空格分隔，整句话会被当作一个 token，导致中文场景下去重几乎完全失效。

### 示例

```
已有记忆："决定使用PostgreSQL作为主数据库"
新记忆：  "决定使用PostgreSQL作为主数据库，版本16"

当前行为：setA = {"决定使用PostgreSQL作为主数据库"}  → 1 个 token
          setB = {"决定使用PostgreSQL作为主数据库，版本16"} → 1 个 token
          Dice = 0（完全不匹配）→ 新建一条几乎重复的记忆

期望行为：利用 Bigram 分词后 Dice 系数约 0.85 → 更新已有记忆
```

### 修改方案

文件：`src/store.ts`，`contentOverlap` 函数

```typescript
// 修改后：复用已有的 extractKeywords 函数
function contentOverlap(a: string, b: string): number {
  const setA = new Set(extractKeywords(a));
  const setB = new Set(extractKeywords(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const w of setA) if (setB.has(w)) overlap++;
  return (2 * overlap) / (setA.size + setB.size);
}
```

工作量：5 分钟

---

## P0-2：scope="both" 时 limit 语义修复（Bug 修复）

### 问题

`memory_search` 和 `memory_list` 在 `scope="both"` 时，分别对 global 和 project 各查 `limit` 条再合并，实际最多返回 `2 * limit` 条结果。用户传 `limit=10` 却收到 20 条，与工具描述不符，也造成不必要的 token 消耗。

### 修改方案

文件：`src/index.ts`，`memory_search` 和 `memory_list` 工具的处理函数

分库各查 `limit` 条，合并后截断为 `limit` 条：

```typescript
// memory_search 工具处理函数，合并后截断
const truncated = results.slice(0, limit);

return {
  content: [{
    type: "text" as const,
    text: truncated.length > 0
      ? `Found ${truncated.length} memories:\n\n${truncated.join("\n")}`
      : "No memories found matching the query.",
  }],
};
```

`memory_list` 同理。

工作量：10 分钟

---

## P1-1：数据库导出/导入（CLI 命令）

### 问题

没有备份或迁移工具。数据库文件损坏或更换机器时，所有记忆丢失。

### 设计

导出/导入是运维操作，不应做成 MCP 工具（避免 AI 能批量写入任意内容，也避免导出结果打进上下文窗口浪费 token）。实现为 **CLI 命令**。

新增文件：`src/cli.ts`

```typescript
import { globalDb, projectDb, addMemory, closeAll } from "./store.js";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Memory } from "./types.js";

const MEMORY_DIR = process.env.MEMORY_DIR || join(process.env.HOME!, ".cursor", "memory");

const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case "export": {
    const scope = args.includes("--global") ? "global" : "both";
    const outputPath = args.find(a => !a.startsWith("--"))
      || join(MEMORY_DIR, `backup-${Date.now()}.json`);

    const result: Record<string, Memory[]> = {};
    if (scope !== "global") {
      // export project db — requires --project flag or cwd detection
      const projectName = args[args.indexOf("--project") + 1] || "default";
      const pDb = projectDb(projectName);
      result[projectName] = pDb.query("SELECT * FROM memories ORDER BY id").all() as Memory[];
    }
    const gDb = globalDb();
    result["global"] = gDb.query("SELECT * FROM memories ORDER BY id").all() as Memory[];

    const total = Object.values(result).reduce((s, a) => s + a.length, 0);
    writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`Exported ${total} memories to: ${outputPath}`);
    closeAll();
    break;
  }

  case "import": {
    const filePath = args.find(a => !a.startsWith("--"));
    if (!filePath) { console.error("Usage: bun run src/cli.ts import <file>"); process.exit(1); }

    const data = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, Memory[]>;
    let imported = 0, merged = 0;

    for (const [label, memories] of Object.entries(data)) {
      const db = label === "global" ? globalDb() : projectDb(label);
      for (const m of memories) {
        const r = addMemory(db, m.content, m.category, m.tags, m.importance, m.source);
        if (r.created_at === r.updated_at) imported++; else merged++;
      }
    }

    console.log(`Import complete: ${imported} new, ${merged} merged.`);
    closeAll();
    break;
  }

  default:
    console.error("Commands: export, import");
    process.exit(1);
}
```

使用方式：

```bash
bun run src/cli.ts export ./backup.json
bun run src/cli.ts import ./backup.json
```

在 `package.json` 中添加快捷脚本：

```json
"scripts": {
  "export": "bun run src/cli.ts export",
  "import": "bun run src/cli.ts import"
}
```

工作量：1 小时

---

## P1-2：隐私双层防御

### 问题

当前没有隐私控制机制。AI 可以将对话中的任何内容（密码、密钥、个人信息）存入记忆数据库。

### 设计

**双层防御**：

1. **被动层（Cursor Rule 指令）**：指导 AI "不要保存凭据类信息"——主要防线，零代码成本
2. **主动层（`<private>` 标签剥离）**：用户手动标记的补充手段——覆盖 AI 判断遗漏的边缘情况

### 修改方案

**第一层：修改 `cursor-rule-template.md`**，增加隐私规则（见 P1-3 中完整的 Rule 模板）。

**第二层：`src/store.ts`**，在 `addMemory` 函数开头增加标签过滤：

```typescript
function stripPrivateTags(content: string): string {
  return content.replace(/<private>[\s\S]*?<\/private>/g, '').trim();
}

export function addMemory(db, content, category, tags, importance, source) {
  const cleaned = stripPrivateTags(content);
  if (!cleaned) {
    return { id: -1, content: '[skipped: private]', /* ... */ } as Memory;
  }
  // 后续使用 cleaned 替代 content ...
}
```

工作量：30 分钟

---

## P1-3：Hooks 自动记忆 + 动态注入（核心新功能）

### 问题

当前系统完全依赖 AI 主动调用 MCP 工具。AI 经常忘记在对话开始时召回记忆，也经常在对话结束时遗漏保存。

### 设计

利用 Cursor Hooks（v1.7+）实现两个自动化：

1. **sessionStart** → 自动注入记忆到 AI 上下文，根据数量动态决定全量/部分注入
2. **stop** → 通过 `followup_message` 提醒 AI 保存会话摘要

MCP Server 始终可用作后备搜索，但小项目不会用到。

### 新增文件

```
src/hooks/
├── session-start.ts    # sessionStart hook：动态注入记忆
└── stop.ts             # stop hook：提醒 AI 保存
```

#### src/hooks/session-start.ts

```typescript
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join, basename } from "path";

const MEMORY_DIR = process.env.MEMORY_DIR || join(process.env.HOME!, ".cursor", "memory");
const THRESHOLD = parseInt(process.env.MEMORY_THRESHOLD || "50");

const input = JSON.parse(await Bun.stdin.text());
const root = input.workspace_roots?.[0] || process.cwd();
const projectName = basename(root);

function openDb(dbPath: string): Database | null {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  return db;
}

function countMemories(db: Database | null): number {
  if (!db) return 0;
  try {
    return (db.query("SELECT COUNT(*) as c FROM memories").get() as any)?.c || 0;
  } catch { return 0; }
}

function getTopMemories(db: Database | null, limit: number, scope: string): string[] {
  if (!db) return [];
  try {
    const rows = db.query(`
      SELECT id, content, category, importance, updated_at
      FROM memories
      ORDER BY importance * (1.0 / (1 + (julianday('now') - julianday(updated_at)))) DESC
      LIMIT ?
    `).all(limit) as any[];
    return rows.map(m =>
      `[${scope}][#${m.id}] (${m.category}, imp:${m.importance}) ${m.content}`
    );
  } catch { return []; }
}

const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, "_");
const projDb = openDb(join(MEMORY_DIR, "projects", `${safeName}.db`));
const gDb = openDb(join(MEMORY_DIR, "global.db"));

const projCount = countMemories(projDb);
const globalCount = countMemories(gDb);
const total = projCount + globalCount;

let context = "";

if (total === 0) {
  context = "No memories stored yet. Important decisions and progress will be saved automatically.";
} else if (total <= THRESHOLD) {
  // 全量注入模式
  const projLines = getTopMemories(projDb, projCount, "project");
  const globalLines = getTopMemories(gDb, globalCount, "global");
  const all = [...projLines, ...globalLines];
  context = [
    `# Recalled Memories (${total} items — full)`,
    "",
    all.join("\n"),
    "",
    "---",
    "All memories loaded. Do NOT call memory_get_context — already done.",
    "Use memory_search only if you need keyword filtering.",
  ].join("\n");
} else {
  // 部分注入模式
  const projLines = getTopMemories(projDb, 15, "project");
  const globalLines = getTopMemories(gDb, 5, "global");
  const all = [...projLines, ...globalLines];
  context = [
    `# Recalled Memories (top 20 of ${total})`,
    "",
    all.join("\n"),
    "",
    "---",
    `${total - 20} more memories available. Use memory_search to find specific topics.`,
    "Do NOT call memory_get_context — top memories already loaded above.",
  ].join("\n");
}

projDb?.close();
gDb?.close();

console.log(JSON.stringify({ additional_context: context }));
```

**设计要点**：

- 直接读 SQLite（`readonly: true`），不经过 MCP Server，无进程间通信开销
- `THRESHOLD` 环境变量可调（默认 50），用户可根据 token 预算调整
- 全量模式 ~50 条 × ~50 token ≈ 2,500 token，可接受
- 部分模式固定注入 20 条 ≈ 1,000 token
- 错误处理：数据库不存在或查询失败时静默降级，不阻塞 Cursor

#### src/hooks/stop.ts

```typescript
const input = JSON.parse(await Bun.stdin.text());

// 防止死循环：followup 完成后 stop 会再次触发
// loop_count > 0 说明已经是 followup 轮次，直接退出
if (input.loop_count > 0) {
  console.log(JSON.stringify({}));
  process.exit(0);
}

// 仅在正常完成时提醒保存，错误/中断时不提醒
if (input.status !== "completed") {
  console.log(JSON.stringify({}));
  process.exit(0);
}

console.log(JSON.stringify({
  followup_message: [
    "Session ending. Review what happened and save key takeaways using memory_add if anything is worth remembering.",
    "",
    "Worth saving: decisions made, architecture choices, bugs found and solutions, significant progress, user preferences.",
    "NOT worth saving: trivial changes, temporary debug attempts, incomplete discussions.",
    "",
    "If nothing important happened, just say 'nothing to save' and stop.",
  ].join("\n"),
}));
```

**设计要点**：

- `loop_limit: 1` 确保只触发一次 followup
- 只在 `status === "completed"` 时提醒，用户中断或出错时不打扰
- AI 自己判断值不值得保存——它有完整的对话上下文，比任何外部脚本判断都准确
- 保存通过 MCP 工具 `memory_add` 完成，利用已有的去重、FTS5 同步等逻辑

#### hooks.json 配置

项目级别 `.cursor/hooks.json`，或全局 `~/.cursor/hooks.json`：

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "command": "bun run /path/to/cursor-memory-server/src/hooks/session-start.ts",
        "timeout": 5
      }
    ],
    "stop": [
      {
        "command": "bun run /path/to/cursor-memory-server/src/hooks/stop.ts",
        "timeout": 3,
        "loop_limit": 1
      }
    ]
  }
}
```

安装脚本需要将 `/path/to/` 替换为实际安装路径。

#### cursor-rule-template.md 更新

需要配合 hooks 更新 Cursor Rule，让 AI 知道两种模式并正确行动（完整内容见下方独立章节）。

### 对比：Hooks 方案 vs claude-mem 方案

| 维度 | 本方案 | claude-mem Cursor Hooks |
|------|--------|------------------------|
| 额外进程 | 无（bun 直接运行 ts） | HTTP 守护进程 + MCP 子进程 |
| 记忆写入方式 | AI 调 MCP 工具（已有上下文） | Hook → HTTP → Worker → AI API 压缩 |
| 额外 AI API 调用 | 零 | 每次 observation 都要 AI 压缩 |
| 记忆质量 | AI 看完整对话上下文后摘要 | 外部 AI 只看单条工具输出 |
| 新增代码量 | ~100 行 TypeScript | ~300 行 bash + 整个 worker |
| Hook 脚本启动时间 | < 50ms（bun 运行 ts） | 需等 worker 就绪（数秒） |

工作量：2 小时

---

## P2-1：数据库迁移机制

### 问题

表结构硬编码在 `initDb` 中。将来加字段（如 `context`、`archived`）没有平滑升级路径。

### 设计

新增 `schema_version` 表，记录每次迁移的版本和时间，支持追溯：

```typescript
const MIGRATIONS: { version: number; sql: string; description: string }[] = [
  { version: 1, sql: "", description: "initial schema (created by initDb)" },
  { version: 2, sql: "ALTER TABLE memories ADD COLUMN context TEXT DEFAULT NULL;", description: "add context field" },
  { version: 3, sql: "ALTER TABLE memories ADD COLUMN archived INTEGER DEFAULT 0;", description: "add archived field" },
];

function runMigrations(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL,
    applied_at TEXT DEFAULT (datetime('now')),
    description TEXT
  )`);

  const row = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number } | null;
  const currentVersion = row?.v || 0;

  for (const m of MIGRATIONS) {
    if (m.version > currentVersion && m.sql) {
      db.exec(m.sql);
    }
    if (m.version > currentVersion) {
      db.query("INSERT INTO schema_version (version, description) VALUES (?, ?)")
        .run(m.version, m.description);
    }
  }
}
```

在 `initDb` 末尾调用 `runMigrations(db)`。

工作量：1 小时

---

## P2-2：记忆自动清理

### 问题

记忆只增不删，长期使用后数据库无限膨胀。

### 设计

自动清理不应做成 MCP 工具（AI 不应有批量删除用户记忆的权限），而是在**数据库打开时自动执行**。

在 `initDb` 末尾添加：

```typescript
function autoCleanup(db: Database) {
  // 低重要性 + 长期未更新 + 未被访问 → 清理
  const deleted = db.query(`
    DELETE FROM memories
    WHERE (importance <= 2 AND updated_at < datetime('now', '-90 days') AND access_count <= 1)
       OR (importance <= 4 AND updated_at < datetime('now', '-180 days') AND access_count <= 1)
  `).run();

  if (deleted.changes > 0) {
    process.stderr.write(`Auto-cleaned ${deleted.changes} stale memories\n`);
  }
}
```

清理策略：
- importance <= 2 且超过 90 天未更新且 access_count <= 1 → 删除
- importance 3-4 且超过 180 天未更新且 access_count <= 1 → 删除
- importance >= 5 → 永不自动清理

工作量：15 分钟

---

## P2-3：项目名检测增强

### 问题

MCP Server 的 `process.cwd()` 由 Cursor 决定，不一定是项目根目录。同名项目会共享数据库。

Hook 脚本有 `workspace_roots` 字段可以准确获取项目路径，但 MCP Server 没有。

### 修改方案

**1. MCP Server：向上查找项目根目录标志**

文件：`src/index.ts`，`resolveProjectName` 函数

```typescript
import { existsSync } from "fs";
import { basename, dirname, join } from "path";

function resolveProjectName(): string {
  if (process.env.PROJECT_NAME) return process.env.PROJECT_NAME;

  let dir = process.cwd();
  const markers = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml"];
  for (let i = 0; i < 10; i++) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) {
        return basename(dir) || "default";
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const parts = process.cwd().split("/").filter(Boolean);
  return parts[parts.length - 1] || "default";
}
```

**2. Hook 脚本：使用 `workspace_roots`**

Hook 脚本从 stdin 拿到的 `workspace_roots[0]` 是 Cursor 提供的准确项目路径，比 `process.cwd()` 可靠。session-start.ts 已经使用了这个字段。

工作量：20 分钟

---

## P3-1：记忆关联上下文

### 问题

每条记忆只有 `content` 正文，缺少"产生时的场景信息"。

### 设计

在 `memories` 表增加 `context` 字段（依赖 P2-1 迁移机制）。

修改 `memory_add` 工具，增加 `context` 参数：

```typescript
context: z.string().max(100).optional()
  .describe("Brief context about when/why this memory was created, max 100 chars")
```

**Token 控制策略**：context 字段仅在 `memory_search` 精确查看时展示，在 sessionStart hook 批量注入时**不展示**，避免 token 膨胀。

```typescript
function formatMemory(m: any, scope?: string, showContext: boolean = false): string {
  const tag = scope ? `[${scope}]` : "";
  const tags = m.tags ? ` tags:${m.tags}` : "";
  const ctx = (showContext && m.context) ? ` [ctx: ${m.context}]` : "";
  return `${tag}[#${m.id}] (${m.category}, importance:${m.importance}${tags}${ctx}) ${m.content} — ${m.updated_at}`;
}
```

工作量：30 分钟

---

## P3-2：全局安装（Hooks + Rules + MCP）

### 问题

当前 `install.sh project` 需为每个项目手动运行一次。新项目容易忘记安装。新增 Hooks 后安装步骤更多。

### 设计

修改 `install.sh`，`global` 命令一次性安装所有组件：

```bash
install_global() {
  INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

  # 1. 安装 MCP 配置到 ~/.cursor/mcp.json（已有逻辑）
  # ...

  # 2. 安装全局 Cursor Rule
  GLOBAL_RULES_DIR="$HOME/.cursor/rules"
  mkdir -p "$GLOBAL_RULES_DIR"
  cp "$INSTALL_DIR/cursor-rule-template.md" "$GLOBAL_RULES_DIR/memory-auto.md"
  ok "Cursor Rule installed: $GLOBAL_RULES_DIR/memory-auto.md"

  # 3. 安装全局 Hooks
  HOOKS_FILE="$HOME/.cursor/hooks.json"
  if [ -f "$HOOKS_FILE" ]; then
    warn "hooks.json already exists: $HOOKS_FILE"
    warn "Please manually merge hook entries from $INSTALL_DIR/hooks.json"
  else
    # 替换路径占位符
    sed "s|/path/to/cursor-memory-server|$INSTALL_DIR|g" \
      "$INSTALL_DIR/hooks.json" > "$HOOKS_FILE"
    ok "Hooks installed: $HOOKS_FILE"
  fi

  ok "Global installation complete. Restart Cursor to activate."
}
```

保留 `project` 命令用于特定项目的自定义覆盖。

工作量：30 分钟

---

## cursor-rule-template.md 更新

配合 Hooks 系统更新 Cursor Rule，让 AI 适配动态注入模式：

```markdown
---
description: Memory system — auto-recall via hooks, manual save via MCP tools
alwaysApply: true
---

# Memory System

You have a persistent memory system. Memories are auto-loaded at session start via hooks.

## Context Recall (Automatic)

Memories appear in your context as "Recalled Memories" at session start.
- If you see **"full"** in the header: all memories are loaded. Do NOT call memory_get_context.
- If you see **"top N of M"**: only high-priority memories are loaded. Use memory_search for specific topics.
- If no memories section appears: hooks may not be installed. Call memory_get_context manually.

## When to Save (Automatic)

Proactively call memory_add when you observe:
- **Decisions**: User makes a technical choice ("use X over Y", "go with this approach")
- **Architecture**: System design choices, data flow, API design
- **Preferences**: Coding style, tools, workflows, response language
- **Progress**: Milestones reached, features completed
- **Bugs**: Important bugs found, root causes, workarounds

Set source: "auto" for these.

## When to Save (Manual)

When user says "remember this" / "记住这个" / "save this", save with source: "manual".

## When to Delete/Update

- "forget this" / "忘掉这个" → memory_delete with the ID shown in [#N]
- "update memory" / "更新记忆" → memory_update
- When a decision is reversed, update the old memory

## Privacy

Do NOT save: passwords, API keys, tokens, secrets, private keys, database credentials, personal IDs.
Only record the fact: "Project uses AWS S3" not "AWS_SECRET_KEY=AKIA..."

## Scope

- **global**: User preferences, universal standards, cross-project patterns
- **project**: Project-specific decisions, architecture, bugs (default)

## Importance

- **9-10**: Critical architecture/technology decisions
- **7-8**: Important preferences, significant milestones
- **5-6**: General notes, minor decisions (default)
- **3-4**: Temporary context, may become irrelevant
- **1-2**: Trivial observations

## Categories

| Category | Use For |
|----------|---------|
| decision | Technical decisions, tool/framework choices |
| architecture | System design, data models, API structure |
| preference | User preferences, coding style, workflow habits |
| progress | Milestones, completed features, project status |
| bug | Bugs, issues, workarounds, root causes |
| general | Anything that doesn't fit above |
```

---

## 实施路线图

```
Phase 1 - Bug 修复（半天）
├── P0-1: 中文去重修复
└── P0-2: scope="both" limit 语义修复

Phase 2 - 核心功能 + 安全（2-3 天）
├── P1-1: 数据库导出/导入（CLI 命令）
├── P1-2: 隐私双层防御
└── P1-3: Hooks 自动记忆 + 动态注入 ★ 核心改动
    ├── session-start.ts（动态全量/部分注入）
    ├── stop.ts（followup_message 提醒保存）
    ├── hooks.json 配置
    └── cursor-rule-template.md 更新

Phase 3 - 可维护性（1-2 天）
├── P2-1: 数据库迁移机制
├── P2-2: 记忆自动清理（initDb 自动执行）
└── P2-3: 项目名检测增强

Phase 4 - 增强功能（1 天）
├── P3-1: 记忆关联上下文（依赖 P2-1）
└── P3-2: 全局安装（Hooks + Rules + MCP 一键安装）
```

### 依赖关系

```
P0-1, P0-2 → 无依赖，可立即开始
P1-1, P1-2 → 无依赖
P1-3 → 无依赖（Hooks 直接读 SQLite，不改 MCP Server 代码）
P2-1 → P3-1 依赖它（context 字段需要迁移机制）
P2-2 → 无依赖
P2-3 → 无依赖
P3-2 → 依赖 P1-3（需要 hooks.json 和更新后的 Rule）
```

### 设计约束

- 不引入新的 npm 依赖
- 不引入常驻守护进程
- SQLite 为唯一数据源
- 冷启动 < 100ms
- 所有 Hook 脚本超时 ≤ 5 秒
- 错误时静默降级，不阻塞 Cursor
