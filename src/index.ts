import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  globalDb,
  projectDb,
  sharedDb,
  addMemory,
  searchMemories,
  listMemories,
  updateMemory,
  deleteMemory,
  getContext,
  closeAll,
} from "./store.js";
import type { MemoryCategory, MemoryScope } from "./types.js";
import { existsSync } from "fs";
import { basename, dirname, join } from "path";

const CATEGORY_VALUES = [
  "decision",
  "architecture",
  "preference",
  "progress",
  "bug",
  "conversation",
  "general",
] as const;

const server = new McpServer({
  name: "cursor-memory",
  version: "1.0.0",
});

// P2-3: Enhanced project detection — walk up to find project root
const PROJECT_MARKERS = [
  ".git", "package.json", "Cargo.toml", "go.mod",
  "pyproject.toml", ".svn", "pom.xml", "build.gradle",
];

function resolveProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function resolveProjectName(): string {
  if (process.env.PROJECT_NAME) return process.env.PROJECT_NAME;
  return basename(resolveProjectRoot()) || "default";
}

function getTargetDb(scope: MemoryScope) {
  const root = resolveProjectRoot();
  if (scope === "global") return [globalDb()];
  if (scope === "project") return [projectDb(root)];
  if (scope === "shared") return [sharedDb(root)];
  // "both" = global + project (shared is opt-in, not included)
  return [globalDb(), projectDb(root)];
}

// P3-1: formatMemory with optional context display
function formatMemory(m: any, scope?: string, showContext: boolean = false): string {
  const tag = scope ? `[${scope}]` : "";
  const tags = m.tags ? ` tags:${m.tags}` : "";
  const ctx = (showContext && m.context) ? ` [ctx: ${m.context}]` : "";
  return `${tag}[#${m.id}] (${m.category}, importance:${m.importance}${tags}${ctx}) ${m.content} — ${m.updated_at}`;
}

// --- Tool: memory_add ---
server.tool(
  "memory_add",
  "Save a new memory. Use this to persist important decisions, preferences, architecture choices, progress notes, bug records, or conversation summaries. For conversation summaries, use category='conversation' with structured content.",
  {
    content: z.string().describe("The memory content to save"),
    category: z
      .enum(CATEGORY_VALUES)
      .optional()
      .describe("Category: decision, architecture, preference, progress, bug, conversation (for chat summaries), general"),
    tags: z.string().optional().describe("Comma-separated tags for this memory"),
    importance: z
      .number()
      .min(1)
      .max(10)
      .optional()
      .describe("Importance level 1-10 (default 5)"),
    scope: z
      .enum(["global", "project", "shared"])
      .optional()
      .describe("Where to save: 'global' (all projects), 'project' (current project, local), or 'shared' (team-shared, stored in project dir). Default: project"),
    source: z
      .enum(["auto", "manual"])
      .optional()
      .describe("Whether this was auto-detected or manually requested"),
    context: z
      .string()
      .max(100)
      .optional()
      .describe("Brief context about when/why this memory was created, max 100 chars"),
    session_id: z
      .string()
      .optional()
      .describe("Session/conversation ID for grouping related memories. Auto-generated if not provided (YYYY-MM-DD-HH format). Use same session_id for all memories from one conversation."),
  },
  async (args) => {
    const scope = args.scope || "project";
    const db = scope === "global" ? globalDb()
             : scope === "shared" ? sharedDb(resolveProjectRoot())
             : projectDb(resolveProjectRoot());
    const memory = addMemory(
      db,
      args.content,
      (args.category as MemoryCategory) || "general",
      args.tags || null,
      args.importance || 5,
      args.source || "auto",
      args.context || null,
      args.session_id || null
    );

    if (memory.id === -1) {
      return {
        content: [{ type: "text" as const, text: "Memory skipped: content was entirely private." }],
      };
    }

    let text = `Memory saved (${scope}): ${formatMemory(memory)}`;
    if (scope === "shared") {
      const dbPath = join(resolveProjectRoot(), ".cursor", "memory", "shared.db");
      text += `\n📁 Shared memory saved to: ${dbPath}`;
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// --- Tool: memory_search ---
server.tool(
  "memory_search",
  "Search memories using full-text search. Returns the most relevant memories matching the query.",
  {
    query: z.string().describe("Search query (keywords or natural language)"),
    category: z.enum(CATEGORY_VALUES).optional().describe("Filter by category"),
    scope: z
      .enum(["global", "project", "shared", "both"])
      .optional()
      .describe("Search scope: global, project, shared, or both (default: both, does not include shared)"),
    limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
  },
  async (args) => {
    const scope = (args.scope as MemoryScope) || "both";
    const limit = args.limit || 20;
    const dbs = getTargetDb(scope);
    const results: string[] = [];

    for (const db of dbs) {
      const scopeLabel = db === globalDb() ? "global"
                       : db === sharedDb(resolveProjectRoot()) ? "shared"
                       : "project";
      const memories = searchMemories(
        db,
        args.query,
        args.category as MemoryCategory | undefined,
        limit
      );
      for (const m of memories) {
        results.push(formatMemory(m, scopeLabel, true));
      }
    }

    // P0-2: Truncate to requested limit when scope="both"
    const truncated = results.slice(0, limit);

    return {
      content: [
        {
          type: "text" as const,
          text: truncated.length > 0
            ? `Found ${truncated.length} memories:\n\n${truncated.join("\n")}`
            : "No memories found matching the query.",
        },
      ],
    };
  }
);

// --- Tool: memory_list ---
server.tool(
  "memory_list",
  "List memories sorted by importance and recency. Use to browse stored memories.",
  {
    category: z.enum(CATEGORY_VALUES).optional().describe("Filter by category"),
    scope: z
      .enum(["global", "project", "shared", "both"])
      .optional()
      .describe("List scope: global, project, shared, or both (default: both, does not include shared)"),
    limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
  },
  async (args) => {
    const scope = (args.scope as MemoryScope) || "both";
    const limit = args.limit || 20;
    const dbs = getTargetDb(scope);
    const results: string[] = [];

    for (const db of dbs) {
      const scopeLabel = db === globalDb() ? "global"
                       : db === sharedDb(resolveProjectRoot()) ? "shared"
                       : "project";
      const memories = listMemories(
        db,
        args.category as MemoryCategory | undefined,
        limit
      );
      for (const m of memories) {
        results.push(formatMemory(m, scopeLabel));
      }
    }

    // P0-2: Truncate to requested limit when scope="both"
    const truncated = results.slice(0, limit);

    return {
      content: [
        {
          type: "text" as const,
          text: truncated.length > 0
            ? `${truncated.length} memories:\n\n${truncated.join("\n")}`
            : "No memories stored yet.",
        },
      ],
    };
  }
);

// --- Tool: memory_delete ---
server.tool(
  "memory_delete",
  "Delete a memory by ID.",
  {
    id: z.number().describe("Memory ID to delete"),
    scope: z
      .enum(["global", "project", "shared"])
      .optional()
      .describe("Which database to delete from: global, project, or shared (default: project)"),
  },
  async (args) => {
    const scope = args.scope || "project";
    const db = scope === "global" ? globalDb()
             : scope === "shared" ? sharedDb(resolveProjectRoot())
             : projectDb(resolveProjectRoot());
    const deleted = deleteMemory(db, args.id);
    return {
      content: [
        {
          type: "text" as const,
          text: deleted
            ? `Memory #${args.id} deleted from ${scope} store.`
            : `Memory #${args.id} not found in ${scope} store.`,
        },
      ],
    };
  }
);

// --- Tool: memory_update ---
server.tool(
  "memory_update",
  "Update an existing memory's content, category, tags, importance, or context.",
  {
    id: z.number().describe("Memory ID to update"),
    content: z.string().optional().describe("New content"),
    category: z.enum(CATEGORY_VALUES).optional().describe("New category"),
    tags: z.string().optional().describe("New tags (comma-separated)"),
    importance: z.number().min(1).max(10).optional().describe("New importance level"),
    context: z
      .string()
      .max(100)
      .optional()
      .describe("New context about when/why this memory exists, max 100 chars"),
    scope: z
      .enum(["global", "project", "shared"])
      .optional()
      .describe("Which database: global, project, or shared (default: project)"),
  },
  async (args) => {
    const scope = args.scope || "project";
    const db = scope === "global" ? globalDb()
             : scope === "shared" ? sharedDb(resolveProjectRoot())
             : projectDb(resolveProjectRoot());
    try {
      const memory = updateMemory(
        db,
        args.id,
        args.content,
        args.category as MemoryCategory | undefined,
        args.tags,
        args.importance,
        args.context
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Memory updated: ${formatMemory(memory, scope, true)}`,
          },
        ],
      };
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool: memory_get_context ---
server.tool(
  "memory_get_context",
  "Retrieve relevant memories for the current project context. Call this at the start of a conversation to recall previous context. Returns a mix of global and project-specific memories ranked by importance and recency.",
  {
    project_name: z
      .string()
      .optional()
      .describe("Project name override (auto-detected if not provided)"),
    limit: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe("Max memories to return (default 30)"),
  },
  async (args) => {
    const projectRoot = args.project_name || resolveProjectRoot();
    const limit = args.limit || 30;
    const memories = getContext(projectRoot, limit);

    if (memories.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No memories stored yet for this project or globally.",
          },
        ],
      };
    }

    const lines = memories.map((m: any) =>
      formatMemory(m, m.scope || "unknown")
    );

    return {
      content: [
        {
          type: "text" as const,
          text: `Recalled ${memories.length} memories:\n\n${lines.join("\n")}`,
        },
      ],
    };
  }
);

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("cursor-memory MCP server running on stdio\n");
}

process.on("SIGINT", () => {
  closeAll();
  process.exit(0);
});

process.on("SIGTERM", () => {
  closeAll();
  process.exit(0);
});

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
