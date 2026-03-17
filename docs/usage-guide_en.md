# Usage Guide

## One-Click Install (Recommended)

```bash
cd cursor-memory-server

# Show help
bash install.sh help

# Install everything: MCP Server + memory rules for a specific project
bash install.sh all /path/to/your-project
```

You can also install step by step:

```bash
# Step 1: Global install (check Bun, install deps, verify server, write MCP config)
bash install.sh global

# Step 2: Enable memory for a project (creates .cursor/rules/memory-auto.md)
bash install.sh project /path/to/my-app
bash install.sh project /path/to/another-app   # Enable for multiple projects
bash install.sh project .                       # Use . for current directory
```

**Restart Cursor** after installation to activate.

---

## Prerequisites

### macOS

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Verify
bun --version   # Requires >= 1.0.0
```

System requirements:
- macOS 12 (Monterey) or later
- Apple Silicon (M1/M2/M3/M4) or Intel x86_64
- Cursor IDE installed

### Linux

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Verify
bun --version   # Requires >= 1.0.0
```

System requirements:
- Linux kernel 5.6 or later (io_uring support required)
- glibc >= 2.27 (Ubuntu 18.04+, Debian 10+, CentOS 8+, Fedora 28+)
- x86_64 or aarch64 architecture
- Cursor IDE installed

### Windows (WSL2)

```bash
# Install Bun inside WSL2
curl -fsSL https://bun.sh/install | bash
```

Native Windows is not yet supported (Bun's Windows support is still maturing). WSL2 is recommended.

### About SQLite

**No separate installation needed.** Bun ships with a built-in `bun:sqlite` module that includes the full SQLite engine and FTS5 extension — no system-level sqlite3 package required.

---

## Manual Setup

### Step 1: Install Dependencies

```bash
cd cursor-memory-server
bun install
```

### Step 2: Verify Server Startup

```bash
bun run src/index.ts
```

On success, it prints `cursor-memory MCP server running on stdio` to stderr. Press `Ctrl+C` to exit.

If it fails, check:
- Bun version >= 1.0.0
- You ran `bun install` in the correct directory

### Step 3: Register MCP Server

Check that `~/.cursor/mcp.json` contains the memory server config:

```json
{
  "mcpServers": {
    "memory": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/cursor-memory-server/src/index.ts"],
      "env": {
        "MEMORY_DIR": "/your/home/.cursor/memory"
      }
    }
  }
}
```

Notes:
- Paths in `args` must be **absolute** — `~` and relative paths are not supported
- `MEMORY_DIR` specifies where database files are stored (default: `~/.cursor/memory`)
- If the file already has other MCP server configs, add the `memory` entry to the existing `mcpServers` object

### Step 4: Add Cursor Rule

Verify that `.cursor/rules/memory-auto.md` exists in your project root. This file instructs the AI to automatically save and recall memories during conversations.

Key config: The `alwaysApply: true` in the file's frontmatter ensures it takes effect in every conversation.

### Step 5: Restart Cursor

Restart Cursor IDE to apply the MCP configuration. After restart, Cursor automatically launches the Memory Server as a child process.

---

## Usage

### Automatic Mode (Zero Effort)

Once configured, everything runs automatically:

1. **Every new conversation**: AI calls `memory_get_context` to recall previously saved memories
2. **During conversation**: AI detects important information and saves it — no special commands needed
3. **Across conversations/restarts**: Memories persist in SQLite and are never lost

The AI automatically identifies and saves the following types of information:

| Type | Example |
|------|---------|
| Technical decisions | "We decided to use PostgreSQL instead of MySQL" |
| Architecture design | "API layer uses REST, frontend is React + Next.js" |
| User preferences | "I prefer functional style" / "Reply in English" |
| Project progress | "Login feature completed" / "Database migration done" |
| Bug records | "FTS5 doesn't support Chinese tokenization, switched to LIKE approach" |

### Manual Control

You can also directly instruct the AI:

**Save a memory:**
- "Remember this"
- "Remember: our password policy is bcrypt + salt"
- "Save this decision"

**View memories:**
- "List all memories"
- "Show project memories"
- "What's in global memory?"

**Search memories:**
- "Search memories about databases"
- "Any memories about React?"

**Delete a memory:**
- "Forget this"
- "Delete memory #5"

**Update a memory:**
- "Change memory #3 importance to 9"
- "Update memory #7 content"

---

## Data Management

### Storage Location

```
~/.cursor/memory/
├── global.db             # Global memories (shared across projects)
└── projects/
    ├── my-chat.db        # my-chat project memories
    ├── web-app.db        # web-app project memories
    └── ...
```

- `global.db`: Stores cross-project information like language preferences and universal coding standards
- `projects/`: One database per project, project name auto-detected from the working directory

### Inspecting Data

Each `.db` file is a standard SQLite database, viewable with any SQLite tool:

```bash
# View global memories
sqlite3 ~/.cursor/memory/global.db \
  "SELECT id, category, importance, substr(content,1,60) FROM memories ORDER BY importance DESC;"

# View all memories for a project
sqlite3 ~/.cursor/memory/projects/my-chat.db \
  "SELECT * FROM memories ORDER BY updated_at DESC;"

# Count memories by category
sqlite3 ~/.cursor/memory/projects/my-chat.db \
  "SELECT category, count(*) FROM memories GROUP BY category;"
```

### Backup & Migration

```bash
# Backup entire memory store
cp -r ~/.cursor/memory/ ~/memory-backup-$(date +%Y%m%d)/

# Migrate to a new machine
scp -r ~/.cursor/memory/ newmachine:~/.cursor/memory/
```

### Clearing Memories

```bash
# Clear all memories (global + all projects)
rm -rf ~/.cursor/memory/

# Clear a specific project's memories
rm ~/.cursor/memory/projects/my-chat.db

# Clear only global memories
rm ~/.cursor/memory/global.db
```

The MCP Server will automatically recreate empty databases on next startup.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_DIR` | `~/.cursor/memory` | Directory for database files |
| `PROJECT_NAME` | Auto-detected (last segment of cwd) | Current project name, determines which project database to use |

Set these in the `env` field of `~/.cursor/mcp.json`:

```json
{
  "env": {
    "MEMORY_DIR": "/custom/path/to/memory",
    "PROJECT_NAME": "my-project"
  }
}
```

In most cases, you don't need to set `PROJECT_NAME` manually — the system auto-detects it from the directory Cursor has open.

---

## Troubleshooting

### MCP Server Not Starting / Memory Tools Not Visible in Cursor

**Check MCP config path:**
```bash
cat ~/.cursor/mcp.json
```
Verify that `args` contains the correct absolute path.

**Test startup manually:**
```bash
bun run /your/path/to/cursor-memory-server/src/index.ts
```
Should output `cursor-memory MCP server running on stdio`. If it errors, troubleshoot based on the error message.

**Check Bun installation:**
```bash
which bun && bun --version
```

### Memories Not Being Saved Automatically

- Confirm `.cursor/rules/memory-auto.md` exists in the project
- Confirm `alwaysApply: true` is in the file's frontmatter
- Ask the AI directly: "Can you see memory-related MCP tools?" to verify tool availability

### Chinese Search Returns No Results

The system uses LIKE pattern matching (not FTS5) for Chinese queries. If no results:
- Try shorter keywords (e.g., "database" instead of "database connection pool optimization")
- Use `memory_list` to browse all memories and confirm the data exists

### Database Corruption

Rare, but if it happens:
```bash
# Check database integrity
sqlite3 ~/.cursor/memory/global.db "PRAGMA integrity_check;"

# If it returns anything other than "ok", delete and rebuild
rm ~/.cursor/memory/global.db
```

### Memories Seem Lost After Restart

Memories are never lost — but if the MCP Server fails to start, the AI cannot call memory tools. Check Cursor's MCP logs or follow the steps above to verify the server is running.
