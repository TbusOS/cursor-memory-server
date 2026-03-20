import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join, basename, dirname } from "path";

const MEMORY_DIR = process.env.MEMORY_DIR || join(process.env.HOME!, ".cursor", "memory");
// Below this threshold, inject full content; above, inject index only
const FULL_THRESHOLD = parseInt(process.env.MEMORY_FULL_THRESHOLD || "15");

const PROJECT_MARKERS = [
  ".git", "package.json", "Cargo.toml", "go.mod",
  "pyproject.toml", ".svn", "pom.xml", "build.gradle",
];

// Same logic as MCP server's resolveProjectRoot()
function resolveProjectRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

const input = JSON.parse(await Bun.stdin.text());
const workspaceRoot: string = input.workspace_roots?.[0] || process.cwd();
const root = resolveProjectRoot(workspaceRoot);

function openDb(dbPath: string): Database | null {
  if (!existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

function countMemories(db: Database | null): number {
  if (!db) return 0;
  try {
    return (db.query("SELECT COUNT(*) as c FROM memories").get() as any)?.c || 0;
  } catch {
    return 0;
  }
}

// Full content line (~100-200 tokens each)
function getFullMemories(db: Database | null, limit: number, scope: string): string[] {
  if (!db) return [];
  try {
    const rows = db.query(`
      SELECT id, content, category, importance, context, updated_at, session_id
      FROM memories
      ORDER BY importance * (1.0 / (1 + (julianday('now') - julianday(updated_at)))) DESC
      LIMIT ?
    `).all(limit) as any[];
    return rows.map((m: any) => {
      const ctx = m.context ? ` [ctx: ${m.context}]` : "";
      const sid = m.session_id ? ` [session: ${m.session_id}]` : "";
      return `[${scope}][#${m.id}] (${m.category}, imp:${m.importance}${ctx}${sid}) ${m.content}`;
    });
  } catch {
    return [];
  }
}

// Index line: compact, ~30 tokens each
function getIndexMemories(db: Database | null, limit: number, scope: string): string[] {
  if (!db) return [];
  try {
    const rows = db.query(`
      SELECT id, content, category, importance, updated_at, session_id
      FROM memories
      ORDER BY importance * (1.0 / (1 + (julianday('now') - julianday(updated_at)))) DESC
      LIMIT ?
    `).all(limit) as any[];
    return rows.map((m: any) => {
      // Truncate content to first 80 chars as title (40 was too short for Chinese)
      const title = m.content.length > 80 ? m.content.slice(0, 80) + "..." : m.content;
      const date = m.updated_at?.slice(0, 10) || "";
      return `[${scope}][#${m.id}] ${m.category} imp:${m.importance} ${date} | ${title}`;
    });
  } catch {
    return [];
  }
}

// Get the most recent conversation summary (category='conversation') for prominent display
function getLastConversation(db: Database | null, scope: string): string | null {
  if (!db) return null;
  try {
    const row = db.query(`
      SELECT id, content, updated_at, session_id
      FROM memories
      WHERE category = 'conversation'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as any;
    if (!row) return null;
    const date = row.updated_at?.slice(0, 10) || "";
    return `[${scope}][#${row.id}] ${date} ${row.content}`;
  } catch {
    return null;
  }
}

// Find project memory DB: try exact match first, then walk up parent paths
// This handles the case where MCP server's cwd differs from workspace root
function findProjectDb(projectRoot: string): Database | null {
  let dir = projectRoot;
  for (let i = 0; i < 10; i++) {
    const dirName = dir.replace(/^\//, "").replace(/\//g, "-");
    const dbPath = join(MEMORY_DIR, "projects", dirName, "memory.db");
    const db = openDb(dbPath);
    if (db && countMemories(db) > 0) return db;
    if (db) db.close();
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const projDb = findProjectDb(root);
const gDb = openDb(join(MEMORY_DIR, "global.db"));
const sDb = openDb(join(root, ".cursor", "memory", "shared.db"));

const projCount = countMemories(projDb);
const globalCount = countMemories(gDb);
const sharedCount = countMemories(sDb);
const total = projCount + globalCount + sharedCount;

let context = "";

// Check for last conversation summary from any scope
const lastConvLines: string[] = [];
for (const [db, scope] of [[projDb, "project"], [sDb, "shared"], [gDb, "global"]] as const) {
  const conv = getLastConversation(db as Database | null, scope);
  if (conv) lastConvLines.push(conv);
}

if (total === 0) {
  context = "No memories stored yet. Important decisions and progress will be saved automatically.";
} else if (total <= FULL_THRESHOLD) {
  // Few memories — inject full content
  const projLines = getFullMemories(projDb, projCount, "project");
  const sharedLines = getFullMemories(sDb, sharedCount, "shared");
  const globalLines = getFullMemories(gDb, globalCount, "global");
  const all = [...projLines, ...sharedLines, ...globalLines];
  const sections: string[] = [
    `# Recalled Memories (${total} items — full)`,
  ];

  if (lastConvLines.length > 0) {
    sections.push("", "## Last Conversation", "", ...lastConvLines);
  }

  sections.push("", "## All Memories", "", all.join("\n"), "",
    "---",
    "All memories loaded in full. Use memory_search for keyword filtering.",
  );
  context = sections.join("\n");
} else {
  // Many memories — inject lightweight index + top 5 full
  const topProjFull = getFullMemories(projDb, 3, "project");
  const topSharedFull = getFullMemories(sDb, 1, "shared");
  const topGlobalFull = getFullMemories(gDb, 1, "global");
  const fullLines = [...topProjFull, ...topSharedFull, ...topGlobalFull].filter(Boolean);

  const projIndex = getIndexMemories(projDb, Math.min(projCount, 30), "project");
  const sharedIndex = getIndexMemories(sDb, Math.min(sharedCount, 10), "shared");
  const globalIndex = getIndexMemories(gDb, Math.min(globalCount, 10), "global");
  // Remove entries already shown in full (by ID match)
  const fullIds = new Set(fullLines.map(l => l.match(/\[#(\d+)\]/)?.[1]).filter(Boolean));
  const indexLines = [...projIndex, ...sharedIndex, ...globalIndex]
    .filter(l => {
      const id = l.match(/\[#(\d+)\]/)?.[1];
      return !fullIds.has(id);
    });

  const sections: string[] = [
    `# Recalled Memories (${total} items)`,
  ];

  if (lastConvLines.length > 0) {
    sections.push("", "## Last Conversation", "", ...lastConvLines);
  }

  sections.push(
    "", "## Recent & Important (full content)", "",
    fullLines.join("\n"),
    "", "## Index (use memory_search to get full details)", "",
    indexLines.join("\n"),
    "", "---",
    "Above is a lightweight index. To read the full content of any memory, use `memory_search` with relevant keywords.",
    "Do NOT call memory_get_context — index already loaded above.",
  );
  context = sections.join("\n");
}

projDb?.close();
gDb?.close();
sDb?.close();

console.log(JSON.stringify({ additional_context: context }));
