# Architecture & Technical Design

This document covers the internal architecture, database design, search engine, recall algorithm, and token efficiency analysis of the Cursor Memory Server.

## System Architecture

The system uses three complementary mechanisms: **Hooks** for automatic lifecycle events, **MCP** for on-demand AI tool calls, and **Rules** for behavior guidance. A dynamic injection strategy means small projects get full memory injection with no MCP overhead, while large projects automatically fall back to partial injection with MCP-powered search.

```
┌──────────────────────────────────────────────────────────────┐
│                        Cursor IDE                             │
│                                                               │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ Hooks (.cursor/hooks.json)                               │ │
│  │                                                          │ │
│  │ sessionStart ──→ session-start.ts ──→ SQLite (readonly)  │ │
│  │                  ├─ count ≤ 50: full injection            │ │
│  │                  └─ count > 50: top-N + "use MCP search" │ │
│  │                                                          │ │
│  │ stop ──→ stop.ts ──→ followup_message                    │ │
│  │          "save key memories using memory_add"             │ │
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

### Three Mechanisms

| Mechanism | Trigger | Role |
|-----------|---------|------|
| **Hooks** | Automatic (lifecycle events) | sessionStart: inject memories; stop: prompt AI to save |
| **MCP Tools** | AI actively calls | On-demand add/search/delete (essential for large memory sets) |
| **Rules** | Automatic (every conversation) | Guide AI behavior: when to save, what to skip, privacy rules |

### Communication Pipeline

1. **Session start**: Cursor fires `sessionStart` hook → `session-start.ts` reads SQLite directly → injects memories as `additional_context` into the AI's context window
2. **During conversation**: AI uses MCP tools (`memory_add`, `memory_search`) as needed, communicating via stdio/JSON-RPC 2.0
3. **Session end**: Cursor fires `stop` hook → `stop.ts` returns a `followup_message` → AI reviews the session, decides what to save, calls `memory_add`
4. `.cursor/rules/memory-auto.md` is injected as a Cursor Rule into every conversation, instructing AI on behavior across all three mechanisms

### Dynamic Injection Strategy

The `sessionStart` hook checks the total memory count and decides how much to inject:

| Memory Count | Injection Mode | MCP Usage |
|-------------|----------------|-----------|
| 0 | Hint only ("no memories yet") | Not needed |
| 1–50 | **Full injection** (all memories in context) | Available but rarely used |
| 51+ | **Partial injection** (top 20 by importance × recency) | AI uses `memory_search` for deeper queries |

The threshold (default: 50) is configurable via the `MEMORY_THRESHOLD` environment variable. The transition is seamless — there is no mode switch, just a gradient from "everything in context" to "highlights + search".

### Component Responsibilities

| Component | File | Role |
|-----------|------|------|
| Session Start Hook | `src/hooks/session-start.ts` | Reads SQLite directly (readonly), dynamically injects memories as `additional_context` |
| Stop Hook | `src/hooks/stop.ts` | Returns `followup_message` prompting AI to save session takeaways |
| MCP Server | `src/index.ts` | Registers 6 MCP tools, receives JSON-RPC requests, validates params (Zod), routes to storage layer |
| Storage Layer | `src/store.ts` | SQLite database management (connection pooling, WAL mode), FTS5 indexing, CRUD operations, search strategies, deduplication |
| Type Definitions | `src/types.ts` | Memory, MemoryCategory, MemoryScope, MemorySource TypeScript types |
| Behavior Rules | `.cursor/rules/memory-auto.md` | Guides AI on when to save/recall, how to categorize, importance scoring, privacy rules |
| Hook Config | `.cursor/hooks.json` | Registers hook scripts with Cursor's lifecycle system |
| MCP Config | `~/.cursor/mcp.json` | Registers the MCP Memory Server with Cursor |
| CLI Tools | `src/cli.ts` | Export/import commands for backup and migration |

---

## Technology Choices

| Technology | Choice | Why Not Alternatives |
|------------|--------|---------------------|
| Runtime | **Bun** | Native TypeScript execution (no tsc/tsx build step needed); built-in `bun:sqlite` (no native module compilation like better-sqlite3); cold start < 100ms (critical for MCP child process). Node.js requires additional tsx or compilation; better-sqlite3 has high compile failure rates on some systems |
| Storage | **SQLite + FTS5** | Embedded, zero-ops (no database service to run); single-file database for easy backup/migration; WAL mode for concurrent reads/writes; FTS5 built-in full-text search with no external dependencies. Redis requires a separate process; ChromaDB/FAISS are overkill for memory use cases; JSON files lack search capability |
| Protocol | **MCP over stdio** | Standard protocol natively supported by Cursor; child process lifecycle managed by Cursor automatically; no additional network ports needed |
| Validation | **Zod** | Bundled as a dependency of the MCP SDK (zero additional cost); auto-generates JSON Schema for tool descriptions |

---

## Database Design

### Dual-Database Architecture

```
~/.cursor/memory/
├── global.db             # Global memory store (shared across all projects)
└── projects/
    ├── my-chat.db        # my-chat project memories
    ├── web-app.db        # web-app project memories
    └── ...
```

- **Global store** (`global.db`): Stores user preferences, universal coding conventions, cross-project knowledge
- **Project stores** (`projects/*.db`): Stores project-specific architecture decisions, progress, bugs, etc.
- Project name auto-detection: Uses `PROJECT_NAME` env var if set, otherwise takes the last segment of `process.cwd()`
- Name sanitization: `replace(/[^a-zA-Z0-9_-]/g, "_")` ensures valid filenames

### Connection Management

```typescript
const dbCache = new Map<string, Database>();
```

- Uses a Map to cache database connections, avoiding repeated opens
- Each database runs `PRAGMA journal_mode=WAL` (Write-Ahead Logging) on first open for better concurrency
- On process exit (SIGINT/SIGTERM), iterates through the cache and closes all connections

### Table Schema

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,           -- Memory text
  category TEXT DEFAULT 'general', -- decision/architecture/preference/progress/bug/general
  tags TEXT,                       -- Comma-separated tags for auxiliary search
  importance INTEGER DEFAULT 5,   -- 1-10, affects recall priority
  source TEXT DEFAULT 'auto',     -- auto (AI-detected) or manual (user-requested)
  created_at TEXT DEFAULT (datetime('now')),  -- UTC creation time
  updated_at TEXT DEFAULT (datetime('now')),  -- UTC last update time
  access_count INTEGER DEFAULT 0  -- Times recalled, for statistics
);
```

### FTS5 Full-Text Index

```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, category, tags,
  content=memories, content_rowid=id
);
```

The FTS5 virtual table is kept in sync with the main table via three triggers:

- `memories_ai` (AFTER INSERT): Syncs new memories to the FTS index
- `memories_ad` (AFTER DELETE): Removes deleted memories from the FTS index
- `memories_au` (AFTER UPDATE): Deletes then re-inserts to refresh the FTS index

---

## Search Engine

The system implements a dual search engine that automatically selects the optimal strategy based on query content.

### Engine 1: FTS5 Full-Text Search (English)

**Trigger condition**: Query text contains no CJK characters (`/[\u4e00-\u9fff]/` detection).

**Pipeline**:

1. Strip special characters, split by whitespace
2. Quote each token and join with OR: `"React" OR "Next" OR "js"`
3. Execute FTS5 MATCH query with `bm25()` for relevance ranking
4. If FTS5 returns no results, automatically falls back to LIKE search

```sql
SELECT m.*, bm25(memories_fts) as rank
FROM memories_fts fts
JOIN memories m ON m.id = fts.rowid
WHERE memories_fts MATCH '"React" OR "Next"'
ORDER BY rank
LIMIT 20;
```

### Engine 2: Bigram LIKE Search (Chinese / CJK)

**Trigger condition**: Query text contains Chinese characters.

**Tokenization strategy** (`extractKeywords` function):

1. Extract continuous CJK character segments (regex `/[\u4e00-\u9fff]+/g`)
2. For segments longer than 2 characters, generate sliding bigrams
3. Extract Latin words (length > 1)
4. Deduplicate to get final keyword list

Example: `"大模型训练方案"` tokenizes to:
- Full segment: `大模型训练方案`
- Bigrams: `大模`, `模型`, `型训`, `训练`, `练方`, `方案`

```sql
SELECT * FROM memories
WHERE (content LIKE '%大模型训练方案%' OR content LIKE '%大模%' OR content LIKE '%模型%' ...)
ORDER BY importance DESC, updated_at DESC
LIMIT 20;
```

### Why Not Use FTS5 for Chinese?

SQLite FTS5's default tokenizer (`unicode61`) does not support Chinese word segmentation. Without space delimiters, an entire Chinese sentence is treated as a single token, making partial matching queries fail. Proper CJK FTS5 support would require an external tokenizer library (e.g., jieba), introducing heavyweight dependencies. The bigram LIKE approach performs well at the memory scale (typically < 10,000 entries), is simple to implement, and has zero external dependencies.

---

## Memory Recall Algorithm

`memory_get_context` is the system's core function, called at the start of every conversation.

### Pipeline

1. Query both `global.db` and `project.db`, fetching `ceil(limit/2)` entries from each
2. Database-level sorting uses inline SQL computation: `importance * (1.0 / (1 + (julianday('now') - julianday(updated_at))))`
3. Merge results from both sources
4. Re-sort at the application layer by `importance * recencyWeight`
5. Take the top N results
6. Update `access_count += 1` for each recalled memory

### Decay Function

```
recencyWeight(updated_at) = 1 / (1 + daysAgo × 0.1)
```

| Time Distance | recencyWeight | Score (importance=10) | Score (importance=3) |
|---------------|---------------|----------------------|---------------------|
| Today | 1.00 | 10.0 | 3.0 |
| 1 day ago | 0.91 | 9.1 | 2.7 |
| 7 days ago | 0.59 | 5.9 | 1.8 |
| 30 days ago | 0.25 | 2.5 | 0.75 |
| 100 days ago | 0.09 | 0.9 | 0.27 |

Key property: **High-importance memories decay slowly.** A 100-day-old memory with importance=10 (score=0.9) still outranks a today's memory with importance=1 (score=1.0). This ensures critical architecture decisions are never forgotten due to the passage of time.

### Why Not Sort by Access Count?

`access_count` is currently used for statistics only, not for ranking. Reasons:

- Frequently recalled memories aren't necessarily the most important — they may just have high keyword match rates
- Popularity-based ranking creates a Matthew effect — the more a memory is recalled, the higher it ranks, preventing new memories from surfacing
- `importance × recencyWeight` better models human memory: important things are remembered longer, trivial things gradually fade

---

## Deduplication Mechanism

Every `memory_add` call performs a deduplication check before insertion.

### Pipeline

1. Use the new memory's content as a query to search existing memories (top 1)
2. Compute the **Dice coefficient** between the new and most similar existing memory:

```
overlap = 2 × |intersection(wordsA, wordsB)| / (|wordsA| + |wordsB|)
```

3. If overlap > 0.8 (80% similar), **update** the existing memory instead of creating a new one
4. If overlap <= 0.8, insert normally

### Example

Existing memory: `"Decided to use PostgreSQL as the primary database"`
New memory: `"Decided to use PostgreSQL as the primary database, version 16"`

Dice coefficient calculation:
- wordsA = {"Decided", "to", "use", "PostgreSQL", "as", "the", "primary", "database"}
- wordsB = {"Decided", "to", "use", "PostgreSQL", "as", "the", "primary", "database,", "version", "16"}
- intersection = {"Decided", "to", "use", "PostgreSQL", "as", "the", "primary"} = 7
- overlap = 2 × 7 / (8 + 10) ≈ 0.78 < 0.8 → **creates new memory**

This is intentional: when new content adds substantive information (like a version number), the system favors creating a new memory rather than overwriting.

---

## MCP Tool Design

### Tool Registration

Tools are registered via `McpServer.tool()` from `@modelcontextprotocol/sdk`. Each tool includes:

- **Name**: MCP tool identifier (e.g., `memory_add`)
- **Description**: Natural language description to help the AI understand when to call this tool
- **Parameter Schema**: Defined with Zod, automatically converted to JSON Schema by the SDK
- **Handler**: Receives validated parameters, returns `CallToolResult`

### 6 Tools Overview

| Tool | R/W | Core Logic |
|------|-----|-----------|
| `memory_add` | Write | Dedup check → insert or update → return result |
| `memory_search` | Read | Language detection → FTS5/LIKE dual engine → merge multi-db results |
| `memory_list` | Read | Sort by importance DESC, updated_at DESC → merge multi-db results |
| `memory_update` | Write | Find → partial update (unchanged fields preserved) → trigger syncs FTS |
| `memory_delete` | Write | DELETE → trigger auto-cleans FTS index |
| `memory_get_context` | Read | Dual-db query → weighted sort → update access_count → return top N |

### Parameter Validation

All tool parameters use Zod schemas. The SDK automatically handles:
- Type validation (string, number, enum)
- Range constraints (importance: min 1, max 10)
- Optional parameter handling (optional + default fallback)
- JSON Schema generation (displayed in Cursor's tool descriptions)

---

## Cursor Rule Behavior Instructions

`.cursor/rules/memory-auto.md` uses `alwaysApply: true` in its frontmatter to ensure injection into every conversation.

The instructions organize AI memory behavior to work with the Hooks + MCP hybrid architecture:

1. **Conversation initialization**: Memories are auto-injected by the `sessionStart` hook. The Rule tells AI to check the "Recalled Memories" header — if it says "full", all memories are loaded and no MCP calls are needed; if it says "top N of M", the AI should use `memory_search` for specific topics.
2. **During conversation**: Detect decisions/preferences/architecture/progress/bugs and proactively call `memory_add`. Privacy rules prevent saving credentials or sensitive data.
3. **Session end**: The `stop` hook prompts the AI to review the session and save takeaways. The Rule provides guidance on what's worth saving vs. what to skip.
4. **Manual control**: Respond to "remember this" / "forget this" user commands.

The rules also define scope selection logic (global vs project), importance scoring criteria (1-10 with scenario examples), a category reference table, and a fallback instruction for environments where hooks are not installed (call `memory_get_context` manually).

---

## Token Efficiency Analysis

A core design goal of the memory system is to **convey maximum useful context with minimum token consumption**. Here's how it compares to alternative approaches and the optimization strategies used at each stage.

### Token Consumption Comparison

| Approach | Tokens per Conversation | Growth Over Time | Information Density |
|----------|------------------------|-------------------|---------------------|
| **Cursor Rules files** | Entire file loaded in full | Linear growth as file grows | Medium: mixes standards and memories |
| **Pasting chat history** | Full conversation transcript | Explodes rapidly, thousands of tokens per conversation | Low: small talk, repetition, exploration process |
| **Skills system** | Full text of each relevant Skill | Grows with number of Skills | Medium: Skill template structure takes space |
| **This MCP Memory** | Only top-N distilled memories | Total grows, but each load is capped | **High: every entry is a distilled conclusion** |

### Why Token Consumption Is Low

**1. Store conclusions, not processes**

A 30-minute conversation about choosing PostgreSQL may generate 3000+ tokens. The memory system stores one sentence:

```
"Decided to use PostgreSQL over MySQL — better JSON support and richer extension ecosystem"
```

This memory is ~30 tokens. **Compression ratio: ~100:1**.

**2. Fixed ceiling, no time-based bloat**

`memory_get_context` has a `limit` parameter (default 30). Regardless of how long you've been using the system or how many memories have accumulated, each conversation loads a bounded number of tokens.

Rough estimate:
- Average memory: ~50 tokens (one sentence + metadata formatting)
- 30 memories ≈ **1,500 tokens**
- Equivalent to about one page of text

Compare: a 200-line Cursor Rules file is ~3,000–5,000 tokens, loaded in full every time with no filtering.

**3. Weighted ranking loads high-value memories first**

Not a random 30 entries — ranked by `importance × recencyWeight`, then top 30 selected:
- Important decisions (importance=9) are recalled even from last month
- Trivial notes (importance=2) naturally drop below rank 30 within days, freeing up token budget

**4. On-demand search, not full-load**

`memory_search` returns only matching memories. When the AI needs to recall database decisions, it searches and returns 2–3 matches (~100–150 tokens), not all 500 stored memories.

**5. Deduplication prevents redundancy**

When the same decision comes up repeatedly (e.g., "use PostgreSQL" mentioned across 10 conversations), deduplication ensures only one memory is stored. Without it, 10 near-identical memories would waste 10× the tokens.

### Quantitative Token Estimate

For an active project over 6 months, averaging 2 meaningful conversations per day:

| Metric | Value |
|--------|-------|
| Accumulated memories | ~300–500 |
| Database size | ~100–200 KB |
| Memories loaded per conversation | 30 (fixed ceiling) |
| Memory tokens per conversation | ~1,500 tokens |
| Tokens for saving memories during conversation | ~100 tokens (tool call + response) |
| **Total memory overhead per conversation** | **~1,600 tokens** |

Compare: storing the same information in a Cursor Rules file would be ~15,000 tokens, **loaded in full every conversation**. The MCP Memory approach saves ~**90%** of token consumption.

### Overhead Breakdown

With the Hooks + MCP hybrid architecture, token overhead is reduced compared to the pure MCP approach:

**Small projects (≤ 50 memories, full injection mode):**

| Source | Estimate |
|--------|----------|
| Hook-injected `additional_context` (all memories) | ~2,500 tokens |
| `.cursor/rules/memory-auto.md` injection | ~500 tokens |
| Tool descriptions (MCP tools registered but unused) | ~800 tokens |
| `memory_add` at session end (stop hook followup) | ~200 tokens |
| **Total** | **~4,000 tokens** |

Note: No `memory_get_context` call needed — the hook handles injection directly, saving one round-trip.

**Large projects (> 50 memories, partial injection mode):**

| Source | Estimate |
|--------|----------|
| Hook-injected `additional_context` (top 20) | ~1,000 tokens |
| `.cursor/rules/memory-auto.md` injection | ~500 tokens |
| Tool descriptions (MCP tools) | ~800 tokens |
| `memory_search` calls during conversation (0-3 calls) | ~300-900 tokens |
| `memory_add` at session end (stop hook followup) | ~200 tokens |
| **Total** | **~2,800–3,400 tokens** |

For reference, a typical conversation consumes 10,000–50,000 tokens total, making the memory system ~**5–25%** of the budget — in exchange for complete cross-conversation context retention.

**Comparison with pure MCP approach (no hooks):**

The previous design required AI to manually call `memory_get_context` (~1,500 tokens round-trip) and relied on AI remembering to save memories. The hooks approach eliminates the recall tool call (saving ~1,500 tokens per conversation) while making saves more reliable via the stop hook followup.
