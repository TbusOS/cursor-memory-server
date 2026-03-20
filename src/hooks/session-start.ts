import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join, basename } from "path";

const MEMORY_DIR = process.env.MEMORY_DIR || join(process.env.HOME!, ".cursor", "memory");
// Below this threshold, inject full content; above, inject index only
const FULL_THRESHOLD = parseInt(process.env.MEMORY_FULL_THRESHOLD || "15");

const input = JSON.parse(await Bun.stdin.text());
const root: string = input.workspace_roots?.[0] || process.cwd();

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
      SELECT id, content, category, importance, context, updated_at
      FROM memories
      ORDER BY importance * (1.0 / (1 + (julianday('now') - julianday(updated_at)))) DESC
      LIMIT ?
    `).all(limit) as any[];
    return rows.map((m: any) => {
      const ctx = m.context ? ` [ctx: ${m.context}]` : "";
      return `[${scope}][#${m.id}] (${m.category}, imp:${m.importance}${ctx}) ${m.content}`;
    });
  } catch {
    return [];
  }
}

// Index line: compact, ~20 tokens each
function getIndexMemories(db: Database | null, limit: number, scope: string): string[] {
  if (!db) return [];
  try {
    const rows = db.query(`
      SELECT id, content, category, importance, updated_at
      FROM memories
      ORDER BY importance * (1.0 / (1 + (julianday('now') - julianday(updated_at)))) DESC
      LIMIT ?
    `).all(limit) as any[];
    return rows.map((m: any) => {
      // Truncate content to first 40 chars as title
      const title = m.content.length > 40 ? m.content.slice(0, 40) + "..." : m.content;
      return `[${scope}][#${m.id}] ${m.category} imp:${m.importance} | ${title}`;
    });
  } catch {
    return [];
  }
}

// Convert "/home/zhangbh/my-app" → "home-zhangbh-my-app" (Claude Code style)
const dirName = root.replace(/^\//, "").replace(/\//g, "-");
const projDb = openDb(join(MEMORY_DIR, "projects", dirName, "memory.db"));
const gDb = openDb(join(MEMORY_DIR, "global.db"));
const sDb = openDb(join(root, ".cursor", "memory", "shared.db"));

const projCount = countMemories(projDb);
const globalCount = countMemories(gDb);
const sharedCount = countMemories(sDb);
const total = projCount + globalCount + sharedCount;

let context = "";

if (total === 0) {
  context = "No memories stored yet. Important decisions and progress will be saved automatically.";
} else if (total <= FULL_THRESHOLD) {
  // Few memories — inject full content
  const projLines = getFullMemories(projDb, projCount, "project");
  const sharedLines = getFullMemories(sDb, sharedCount, "shared");
  const globalLines = getFullMemories(gDb, globalCount, "global");
  const all = [...projLines, ...sharedLines, ...globalLines];
  context = [
    `# Recalled Memories (${total} items — full)`,
    "",
    all.join("\n"),
    "",
    "---",
    "All memories loaded in full. Use memory_search for keyword filtering.",
  ].join("\n");
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

  context = [
    `# Recalled Memories (${total} items)`,
    "",
    "## Recent & Important (full content)",
    "",
    fullLines.join("\n"),
    "",
    "## Index (use memory_search to get full details)",
    "",
    indexLines.join("\n"),
    "",
    "---",
    "Above is a lightweight index. To read the full content of any memory, use `memory_search` with relevant keywords.",
    "Do NOT call memory_get_context — index already loaded above.",
  ].join("\n");
}

projDb?.close();
gDb?.close();
sDb?.close();

console.log(JSON.stringify({ additional_context: context }));
