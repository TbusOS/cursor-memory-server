# Cursor Memory Server

[中文文档](README_zh.md)

A persistent memory system for Cursor IDE based on MCP (Model Context Protocol). It enables AI to retain context across conversations and sessions — delivering a Claude Memory-like experience right inside Cursor.

## Key Features

- **Cross-conversation persistence** — Restart Cursor, open a new chat, and AI automatically recalls prior context
- **Dual-layer memory** — Global memories (shared across all projects) + Project memories (isolated per project)
- **Hybrid save modes** — AI auto-detects important info + user manual control ("remember this" / "forget this")
- **Bilingual search** — FTS5 full-text search for English + bigram LIKE fallback for Chinese (CJK)
- **Auto-deduplication** — When a new memory overlaps > 80% with an existing one, it merges instead of duplicating
- **Weighted recall** — Memories ranked by `importance × recencyWeight`, prioritizing important and fresh entries

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│                      Cursor IDE                         │
│                                                         │
│  ┌───────────┐    stdio      ┌────────────────────────┐ │
│  │  AI Chat   │◄────────────►│  MCP Memory Server     │ │
│  │  (Agent)   │  JSON-RPC    │  (Bun + TypeScript)    │ │
│  └───────────┘               └──────────┬─────────────┘ │
│       ▲                                 │               │
│       │                        ┌────────┴────────┐      │
│  .cursor/rules/                │                 │      │
│  memory-auto.md          ┌─────┴─────┐    ┌──────┴────┐ │
│  (behavior rules)        │ global.db  │    │ project/  │ │
│                          │ (global)   │    │  *.db     │ │
│                          └───────────┘    │ (per-proj) │ │
│                                           └───────────┘ │
│                          ~/.cursor/memory/               │
└─────────────────────────────────────────────────────────┘
```

Cursor launches the Memory Server as a child process via MCP. The AI communicates with it over stdio using JSON-RPC 2.0. A Cursor Rule file (`.cursor/rules/memory-auto.md`) injects behavior instructions into every conversation, telling the AI when and how to save/recall memories.

## Documentation

- [Usage Guide (EN)](docs/usage-guide_en.md) — Installation, configuration, usage, troubleshooting
- [Architecture & Design (EN)](docs/architecture_en.md) — System design, database schema, search engine, recall algorithm
- [使用说明 (中文)](docs/usage-guide.md)
- [技术实现原理 (中文)](docs/architecture_zh.md)

## Project Structure

```
cursor-memory-server/
├── src/
│   ├── index.ts       # MCP server entry — registers 6 tools
│   ├── store.ts       # SQLite storage layer (FTS5 + LIKE dual search)
│   └── types.ts       # TypeScript type definitions
├── docs/
│   ├── usage-guide.md          # Usage guide (Chinese)
│   ├── usage-guide_en.md       # Usage guide (English)
│   ├── architecture_zh.md      # Technical design (Chinese)
│   └── architecture_en.md      # Technical design (English)
├── cursor-rule-template.md     # Cursor Rule template for projects
├── install.sh                  # One-click install script
├── package.json
├── tsconfig.json
└── README.md
```

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.0.0 (runtime with built-in SQLite & TypeScript support)
- [Cursor IDE](https://cursor.com)

### Install

```bash
# Clone the repo
git clone https://github.com/TbusOS/cursor-memory-server.git
cd cursor-memory-server

# One-click install: MCP server + project memory rules
bash install.sh all /path/to/your-project

# Or install step by step:
bash install.sh global                        # Install MCP server globally
bash install.sh project /path/to/your-project # Enable memory for a specific project
```

Restart Cursor after installation. That's it — start chatting and the AI will automatically recall and save memories.

### Manual Installation

If you prefer to set things up manually:

```bash
# 1. Install dependencies
bun install

# 2. Test the server
bun run src/index.ts
# Should print: "cursor-memory MCP server running on stdio"

# 3. Add to ~/.cursor/mcp.json
```

```json
{
  "mcpServers": {
    "memory": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/cursor-memory-server/src/index.ts"],
      "env": {
        "MEMORY_DIR": "~/.cursor/memory"
      }
    }
  }
}
```

```bash
# 4. Copy the Cursor Rule to your project
mkdir -p /path/to/your-project/.cursor/rules
cp cursor-rule-template.md /path/to/your-project/.cursor/rules/memory-auto.md

# 5. Restart Cursor
```

## MCP Tools

The server exposes 6 MCP tools:

| Tool | Type | Description |
|------|------|-------------|
| `memory_add` | Write | Save a new memory with deduplication check |
| `memory_search` | Read | Full-text search across memories (FTS5 / LIKE) |
| `memory_list` | Read | Browse memories sorted by importance & recency |
| `memory_update` | Write | Partially update an existing memory |
| `memory_delete` | Write | Delete a memory by ID |
| `memory_get_context` | Read | Recall top-N memories for current context (called at conversation start) |

## Usage

### Automatic Mode (Zero Configuration)

Once installed, everything works automatically:

1. **Every new conversation**: AI calls `memory_get_context` to recall relevant memories
2. **During conversation**: AI detects and saves important decisions, preferences, architecture choices, progress, and bugs
3. **Across restarts**: Memories persist in SQLite — nothing is lost

### Manual Control

You can also explicitly instruct the AI:

- **Save**: "Remember this" / "记住这个"
- **Search**: "Search memories about databases" / "搜索关于数据库的记忆"
- **List**: "Show all memories" / "列出所有记忆"
- **Delete**: "Forget this" / "忘掉这个" / "Delete memory #5"
- **Update**: "Update memory #3 importance to 9"

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | **Bun** | Native TypeScript execution, built-in `bun:sqlite`, cold start < 100ms |
| Storage | **SQLite + FTS5** | Embedded, zero-ops, single-file DB, WAL mode, built-in full-text search |
| Protocol | **MCP over stdio** | Native Cursor support, lifecycle managed by IDE, no network ports needed |
| Validation | **Zod** | Bundled with MCP SDK, auto JSON Schema generation |

## Data Storage

```
~/.cursor/memory/
├── global.db             # Global memories (shared across projects)
└── projects/
    ├── my-project.db     # Project-specific memories
    ├── web-app.db
    └── ...
```

Each `.db` file is a standard SQLite database. You can inspect them with any SQLite tool:

```bash
sqlite3 ~/.cursor/memory/global.db "SELECT id, category, importance, substr(content,1,60) FROM memories ORDER BY importance DESC;"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_DIR` | `~/.cursor/memory` | Directory for database files |
| `PROJECT_NAME` | Auto-detected from cwd | Override project name for database isolation |

## License

MIT

## Contributing

Issues and pull requests are welcome. Please see the [Architecture docs](docs/architecture_en.md) to understand the system design before contributing.
