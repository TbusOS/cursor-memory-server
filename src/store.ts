import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { Memory, MemoryCategory, MemorySource } from "./types.js";

const MEMORY_DIR = process.env.MEMORY_DIR || join(process.env.HOME!, ".cursor", "memory");
const PROJECTS_DIR = join(MEMORY_DIR, "projects");

function ensureDirs() {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
  if (!existsSync(PROJECTS_DIR)) mkdirSync(PROJECTS_DIR, { recursive: true });
}

function initDb(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      tags TEXT,
      importance INTEGER DEFAULT 5,
      source TEXT DEFAULT 'auto',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0
    );
  `);

  const hasFts = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")
    .get();

  if (!hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content, category, tags,
        content=memories, content_rowid=id
      );

      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, category, tags)
        VALUES (new.id, new.content, new.category, new.tags);
      END;

      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category, tags)
        VALUES ('delete', old.id, old.content, old.category, old.tags);
      END;

      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category, tags)
        VALUES ('delete', old.id, old.content, old.category, old.tags);
        INSERT INTO memories_fts(rowid, content, category, tags)
        VALUES (new.id, new.content, new.category, new.tags);
      END;
    `);
  }
}

// --- P2-1: Database migration mechanism ---

const MIGRATIONS: { version: number; sql: string; description: string }[] = [
  { version: 1, sql: "", description: "initial schema (created by initDb)" },
  {
    version: 2,
    sql: "ALTER TABLE memories ADD COLUMN context TEXT DEFAULT NULL;",
    description: "add context field",
  },
  {
    version: 3,
    sql: "ALTER TABLE memories ADD COLUMN archived INTEGER DEFAULT 0;",
    description: "add archived field",
  },
];

function runMigrations(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL,
    applied_at TEXT DEFAULT (datetime('now')),
    description TEXT
  )`);

  const row = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number | null } | null;
  const currentVersion = row?.v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version > currentVersion) {
      if (m.sql) {
        try {
          db.exec(m.sql);
        } catch (e: any) {
          if (!e.message?.includes("duplicate column")) throw e;
        }
      }
      db.query("INSERT INTO schema_version (version, description) VALUES (?, ?)")
        .run(m.version, m.description);
    }
  }
}

// --- P2-2: Auto cleanup of stale memories ---

function autoCleanup(db: Database) {
  try {
    const result = db.query(`
      DELETE FROM memories
      WHERE (importance <= 2 AND updated_at < datetime('now', '-90 days') AND access_count <= 1)
         OR (importance <= 4 AND updated_at < datetime('now', '-180 days') AND access_count <= 1)
    `).run();

    if (result.changes > 0) {
      process.stderr.write(`Auto-cleaned ${result.changes} stale memories\n`);
    }
  } catch {
    // Silent fail - cleanup is best-effort
  }
}

// --- Database connection pool ---

const dbCache = new Map<string, Database>();

function getDb(path: string): Database {
  let db = dbCache.get(path);
  if (!db) {
    db = new Database(path);
    db.exec("PRAGMA journal_mode=WAL");
    initDb(db);
    runMigrations(db);
    autoCleanup(db);
    dbCache.set(path, db);
  }
  return db;
}

export function globalDb(): Database {
  ensureDirs();
  return getDb(join(MEMORY_DIR, "global.db"));
}

export function projectDb(projectRoot: string): Database {
  ensureDirs();
  // Convert "/home/zhangbh/my-app" → "-home-zhangbh-my-app" (Claude Code style)
  const dirName = projectRoot.replace(/^\//, "").replace(/\//g, "-");
  const projDir = join(PROJECTS_DIR, dirName);
  if (!existsSync(projDir)) mkdirSync(projDir, { recursive: true });
  return getDb(join(projDir, "memory.db"));
}

export function sharedDb(projectRoot: string): Database {
  const sharedDir = join(projectRoot, ".cursor", "memory");
  if (!existsSync(sharedDir)) mkdirSync(sharedDir, { recursive: true });
  return getDb(join(sharedDir, "shared.db"));
}

// --- P1-2: Privacy - strip private tags ---

function stripPrivateTags(content: string): string {
  return content.replace(/<private>[\s\S]*?<\/private>/g, "").trim();
}

// --- Content length limit ---
const MAX_MEMORY_LENGTH = parseInt(process.env.MAX_MEMORY_LENGTH || "500");

function truncateContent(content: string): string {
  if (content.length <= MAX_MEMORY_LENGTH) return content;
  // Cut at last sentence boundary within limit, or hard cut
  const truncated = content.slice(0, MAX_MEMORY_LENGTH);
  const lastSentence = truncated.match(/.*[。.!！?？\n]/s);
  return (lastSentence?.[0] || truncated).trim() + "…";
}

// --- Memory CRUD ---

export function addMemory(
  db: Database,
  content: string,
  category: MemoryCategory = "general",
  tags: string | null = null,
  importance: number = 5,
  source: MemorySource = "auto",
  context: string | null = null
): Memory {
  const cleaned = truncateContent(stripPrivateTags(content));
  if (!cleaned) {
    return {
      id: -1,
      content: "[skipped: private]",
      category,
      tags,
      importance,
      source,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      access_count: 0,
      context: null,
      archived: 0,
    };
  }

  const existing = searchMemories(db, cleaned, undefined, 1);
  if (existing.length > 0) {
    const similarity = contentOverlap(existing[0].content, cleaned);
    if (similarity > 0.8) {
      return updateMemory(db, existing[0].id, cleaned, category, tags, importance, context);
    }
  }

  const stmt = db.prepare(`
    INSERT INTO memories (content, category, tags, importance, source, context)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(cleaned, category, tags, importance, source, context);
  const row = db.query("SELECT last_insert_rowid() as id").get() as { id: number };
  return db.query("SELECT * FROM memories WHERE id = ?").get(row.id) as Memory;
}

export function searchMemories(
  db: Database,
  query: string,
  category?: MemoryCategory,
  limit: number = 20
): Memory[] {
  const trimmed = query.trim();
  if (!trimmed) return listMemories(db, category, limit);

  const hasChinese = /[\u4e00-\u9fff]/.test(trimmed);

  if (hasChinese) {
    return searchByLike(db, trimmed, category, limit);
  }

  const ftsQuery = trimmed
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(" OR ");

  if (!ftsQuery) return searchByLike(db, trimmed, category, limit);

  try {
    let sql = `
      SELECT m.*, bm25(memories_fts) as rank
      FROM memories_fts fts
      JOIN memories m ON m.id = fts.rowid
      WHERE memories_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (category) {
      sql += " AND m.category = ?";
      params.push(category);
    }

    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    const results = db.query(sql).all(...params) as Memory[];
    if (results.length > 0) return results;
    return searchByLike(db, trimmed, category, limit);
  } catch {
    return searchByLike(db, trimmed, category, limit);
  }
}

function searchByLike(
  db: Database,
  query: string,
  category?: MemoryCategory,
  limit: number = 20
): Memory[] {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return listMemories(db, category, limit);

  const conditions = keywords.map(() =>
    "(content LIKE ? OR tags LIKE ? OR category LIKE ?)"
  );
  let sql = `SELECT * FROM memories WHERE (${conditions.join(" OR ")})`;
  const params: (string | number)[] = [];

  for (const kw of keywords) {
    const like = `%${kw}%`;
    params.push(like, like, like);
  }

  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }

  sql += " ORDER BY importance DESC, updated_at DESC LIMIT ?";
  params.push(limit);

  return db.query(sql).all(...params) as Memory[];
}

function extractKeywords(text: string): string[] {
  const cjkChunks = text.match(/[\u4e00-\u9fff]+/g) || [];
  const latinWords = text
    .replace(/[\u4e00-\u9fff]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const keywords: string[] = [...latinWords];

  for (const chunk of cjkChunks) {
    keywords.push(chunk);
    if (chunk.length > 2) {
      for (let i = 0; i <= chunk.length - 2; i++) {
        keywords.push(chunk.slice(i, i + 2));
      }
    }
  }

  return [...new Set(keywords)];
}

export function listMemories(
  db: Database,
  category?: MemoryCategory,
  limit: number = 20
): Memory[] {
  let sql = "SELECT * FROM memories";
  const params: (string | number)[] = [];

  if (category) {
    sql += " WHERE category = ?";
    params.push(category);
  }

  sql += " ORDER BY importance DESC, updated_at DESC LIMIT ?";
  params.push(limit);

  return db.query(sql).all(...params) as Memory[];
}

export function updateMemory(
  db: Database,
  id: number,
  content?: string,
  category?: MemoryCategory,
  tags?: string | null,
  importance?: number,
  context?: string | null
): Memory {
  const current = db.query("SELECT * FROM memories WHERE id = ?").get(id) as Memory | null;
  if (!current) throw new Error(`Memory with id ${id} not found`);

  db.query(`
    UPDATE memories SET
      content = ?,
      category = ?,
      tags = ?,
      importance = ?,
      context = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    content ?? current.content,
    category ?? current.category,
    tags !== undefined ? tags : current.tags,
    importance ?? current.importance,
    context !== undefined ? context : current.context,
    id
  );

  return db.query("SELECT * FROM memories WHERE id = ?").get(id) as Memory;
}

export function deleteMemory(db: Database, id: number): boolean {
  const result = db.query("DELETE FROM memories WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getContext(
  projectRoot: string,
  limit: number = 30
): Memory[] {
  const gDb = globalDb();
  const pDb = projectDb(projectRoot);

  const globalMemories = gDb.query(`
    SELECT *, 'global' as scope FROM memories
    ORDER BY
      importance * (1.0 / (1 + (julianday('now') - julianday(updated_at)))) DESC
    LIMIT ?
  `).all(Math.ceil(limit / 2)) as (Memory & { scope: string })[];

  const projectMemories = pDb.query(`
    SELECT *, 'project' as scope FROM memories
    ORDER BY
      importance * (1.0 / (1 + (julianday('now') - julianday(updated_at)))) DESC
    LIMIT ?
  `).all(Math.ceil(limit / 2)) as (Memory & { scope: string })[];

  const all = [...projectMemories, ...globalMemories];

  all.sort((a, b) => {
    const scoreA = a.importance * recencyWeight(a.updated_at);
    const scoreB = b.importance * recencyWeight(b.updated_at);
    return scoreB - scoreA;
  });

  const ids = all.slice(0, limit);

  for (const m of ids) {
    const target = (m as any).scope === "global" ? gDb : pDb;
    target.query("UPDATE memories SET access_count = access_count + 1 WHERE id = ?").run(m.id);
  }

  return ids;
}

function recencyWeight(dateStr: string): number {
  const daysAgo = (Date.now() - new Date(dateStr + "Z").getTime()) / 86400000;
  return 1 / (1 + daysAgo * 0.1);
}

// P0-1: Fixed — use extractKeywords instead of split(/\s+/) for CJK support
function contentOverlap(a: string, b: string): number {
  const setA = new Set(extractKeywords(a));
  const setB = new Set(extractKeywords(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const w of setA) if (setB.has(w)) overlap++;
  return (2 * overlap) / (setA.size + setB.size);
}

export function closeAll() {
  for (const db of dbCache.values()) db.close();
  dbCache.clear();
}
