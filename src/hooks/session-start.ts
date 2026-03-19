import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join, basename } from "path";

const MEMORY_DIR = process.env.MEMORY_DIR || join(process.env.HOME!, ".cursor", "memory");
const THRESHOLD = parseInt(process.env.MEMORY_THRESHOLD || "50");

const input = JSON.parse(await Bun.stdin.text());
const root: string = input.workspace_roots?.[0] || process.cwd();
const projectName = basename(root);

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

function getTopMemories(db: Database | null, limit: number, scope: string): string[] {
  if (!db) return [];
  try {
    const rows = db.query(`
      SELECT id, content, category, importance, updated_at
      FROM memories
      ORDER BY importance * (1.0 / (1 + (julianday('now') - julianday(updated_at)))) DESC
      LIMIT ?
    `).all(limit) as any[];
    return rows.map((m: any) =>
      `[${scope}][#${m.id}] (${m.category}, imp:${m.importance}) ${m.content}`
    );
  } catch {
    return [];
  }
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
