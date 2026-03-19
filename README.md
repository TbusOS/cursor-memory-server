# Cursor Memory Server

[中文文档](README_zh.md)

A persistent memory system for Cursor IDE based on **Hooks + MCP** hybrid architecture. It enables AI to retain context across conversations and sessions — delivering a Claude Memory-like experience right inside Cursor.

## Key Features

- **Auto-recall via Hooks** — Memories are automatically injected at session start, no manual tool calls needed
- **Auto-save prompting** — Stop hook reminds AI to save key takeaways before session ends
- **Dynamic injection** — Small projects get full memory injection; large projects get top-N with MCP search fallback
- **Dual-layer memory** — Global memories (shared across all projects) + Project memories (isolated per project)
- **Hybrid save modes** — AI auto-detects important info + user manual control ("remember this" / "forget this")
- **Bilingual search** — FTS5 full-text search for English + bigram LIKE fallback for Chinese (CJK)
- **Auto-deduplication** — When a new memory overlaps > 80% with an existing one, it merges instead of duplicating
- **Weighted recall** — Memories ranked by `importance × recencyWeight`, prioritizing important and fresh entries
- **Privacy protection** — Cursor Rule prevents saving credentials; `<private>` tags for manual exclusion

## How It Works

```
┌──────────────────────────────────────────────────────────────┐
│                        Cursor IDE                             │
│                                                               │
│  Hooks (.cursor/hooks.json)                                   │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ sessionStart → session-start.ts → read SQLite            │ │
│  │               ├─ ≤50 memories: inject ALL into context   │ │
│  │               └─ >50 memories: inject top-20 + hint      │ │
│  │                                                          │ │
│  │ stop → stop.ts → "save key memories using memory_add"    │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌───────────┐    stdio      ┌────────────────────────────┐   │
│  │  AI Chat   │◄────────────►│  MCP Memory Server         │   │
│  │  (Agent)   │  JSON-RPC    │  (Bun + TypeScript)        │   │
│  └───────────┘               └──────────┬─────────────────┘   │
│       ▲                                 │                     │
│       │                        ┌────────┴────────┐            │
│  .cursor/rules/                │                 │            │
│  memory-auto.md          ┌─────┴─────┐    ┌──────┴────┐      │
│  (behavior rules)        │ global.db  │    │ project/  │      │
│                          │ (global)   │    │  *.db     │      │
│                          └───────────┘    │ (per-proj) │      │
│                                           └───────────┘      │
│                          ~/.cursor/memory/                     │
└──────────────────────────────────────────────────────────────┘
```

**Three mechanisms work together:**

1. **Hooks** (automatic) — `sessionStart` injects recalled memories into AI context; `stop` prompts AI to save session takeaways
2. **MCP Tools** (on-demand) — AI calls `memory_add`, `memory_search`, `memory_delete` as needed during conversation
3. **Cursor Rules** (guidance) — Tells AI when to save, what to skip, privacy rules, importance scoring

The system dynamically adapts: small projects get full memory injection with no MCP overhead, while large projects automatically fall back to partial injection with MCP-powered search.

## Documentation

- [Usage Guide (EN)](docs/usage-guide_en.md) — Installation, configuration, usage, troubleshooting
- [Architecture & Design (EN)](docs/architecture_en.md) — System design, database schema, search engine, recall algorithm
- [Improvement Plan](docs/improvement-plan.md) — Roadmap and planned enhancements
- [使用说明 (中文)](docs/usage-guide.md)
- [技术实现原理 (中文)](docs/architecture_zh.md)

## Project Structure

```
cursor-memory-server/
├── src/
│   ├── index.ts              # MCP server entry — registers 6 tools
│   ├── store.ts              # SQLite storage layer (FTS5 + LIKE dual search)
│   ├── types.ts              # TypeScript type definitions
│   ├── cli.ts                # CLI commands (export/import)
│   └── hooks/
│       ├── session-start.ts  # sessionStart hook: dynamic memory injection
│       └── stop.ts           # stop hook: prompt AI to save memories
├── docs/
│   ├── usage-guide.md          # Usage guide (Chinese)
│   ├── usage-guide_en.md       # Usage guide (English)
│   ├── architecture_zh.md      # Technical design (Chinese)
│   ├── architecture_en.md      # Technical design (English)
│   └── improvement-plan.md     # Roadmap
├── hooks.json                  # Cursor hooks configuration template
├── cursor-rule-template.md     # Cursor Rule template
├── install.sh                  # One-click install script
├── package.json
├── tsconfig.json
└── README.md
```

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.0.0 (runtime with built-in SQLite & TypeScript support)
- [Cursor IDE](https://cursor.com) >= 1.7 (hooks support required)

### Install

```bash
# Clone the repo
git clone https://github.com/TbusOS/cursor-memory-server.git
cd cursor-memory-server

# One-click install: MCP server + hooks + rules
bash install.sh all /path/to/your-project

# Or install step by step:
bash install.sh global                        # Install MCP server + hooks globally
bash install.sh project /path/to/your-project # Enable memory for a specific project
```

Restart Cursor after installation. That's it — memories are automatically recalled and saved across sessions.

### Manual Installation

If you prefer to set things up manually:

```bash
# 1. Install dependencies
bun install

# 2. Test the server
bun run src/index.ts
# Should print: "cursor-memory MCP server running on stdio"

# 3. Add MCP server to ~/.cursor/mcp.json
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
# 4. Install hooks (replace /absolute/path/to/ with your actual path)
# Copy hooks.json to ~/.cursor/hooks.json (global) or .cursor/hooks.json (project)
# Edit the paths in hooks.json to point to your installation

# 5. Copy the Cursor Rule to your project
mkdir -p /path/to/your-project/.cursor/rules
cp cursor-rule-template.md /path/to/your-project/.cursor/rules/memory-auto.md

# 6. Restart Cursor
```

## MCP Tools

The server exposes 6 MCP tools. With hooks installed, `memory_get_context` is called automatically — you typically only need `memory_add`, `memory_search`, and `memory_delete`.

| Tool | Type | Description |
|------|------|-------------|
| `memory_add` | Write | Save a new memory with deduplication check |
| `memory_search` | Read | Full-text search across memories (FTS5 / LIKE) |
| `memory_list` | Read | Browse memories sorted by importance & recency |
| `memory_update` | Write | Partially update an existing memory |
| `memory_delete` | Write | Delete a memory by ID |
| `memory_get_context` | Read | Recall top-N memories (auto-handled by hooks if installed) |

## Usage

### With Hooks (Recommended)

Once hooks are installed, everything is automatic:

1. **Session start**: `sessionStart` hook injects recalled memories into AI context — no manual calls needed
2. **During conversation**: AI detects and saves important decisions, preferences, architecture choices, progress, and bugs
3. **Session end**: `stop` hook prompts AI to review and save key takeaways
4. **Across restarts**: Memories persist in SQLite — nothing is lost

### Without Hooks (Fallback)

If hooks are not installed (Cursor < 1.7), the system falls back to the MCP-only mode:

1. **Every new conversation**: AI calls `memory_get_context` to recall relevant memories
2. **During conversation**: AI saves memories via `memory_add`

### Manual Control

You can also explicitly instruct the AI:

- **Save**: "Remember this" / "记住这个"
- **Search**: "Search memories about databases" / "搜索关于数据库的记忆"
- **List**: "Show all memories" / "列出所有记忆"
- **Delete**: "Forget this" / "忘掉这个" / "Delete memory #5"
- **Update**: "Update memory #3 importance to 9"

### Backup & Migration

```bash
# Export all memories to JSON
bun run src/cli.ts export ./backup.json

# Import from backup
bun run src/cli.ts import ./backup.json
```

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | **Bun** | Native TypeScript execution, built-in `bun:sqlite`, cold start < 100ms |
| Storage | **SQLite + FTS5** | Embedded, zero-ops, single-file DB, WAL mode, built-in full-text search |
| Protocol | **MCP over stdio** | Native Cursor support, lifecycle managed by IDE, no network ports needed |
| Hooks | **Cursor Hooks (v1.7+)** | sessionStart for auto-recall, stop for auto-save prompting |
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
| `MEMORY_THRESHOLD` | `50` | Memory count threshold for full vs. partial injection |

## License

MIT

## Contributing

Issues and pull requests are welcome. Please see the [Architecture docs](docs/architecture_en.md) to understand the system design before contributing.
