import { globalDb, projectDb, addMemory, closeAll } from "./store.js";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, basename } from "path";
import type { Memory, MemoryCategory, MemorySource } from "./types.js";

const MEMORY_DIR = process.env.MEMORY_DIR || join(process.env.HOME!, ".cursor", "memory");

const command = process.argv[2];
const args = process.argv.slice(3);

function findFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function positionalArg(): string | undefined {
  return args.find((a) => !a.startsWith("--"));
}

switch (command) {
  case "export": {
    const scopeFlag = hasFlag("--global") ? "global" : "both";
    const outputPath = positionalArg() || join(MEMORY_DIR, `backup-${Date.now()}.json`);

    const result: Record<string, Memory[]> = {};

    if (scopeFlag !== "project") {
      const gDb = globalDb();
      result["global"] = gDb.query("SELECT * FROM memories ORDER BY id").all() as Memory[];
    }

    if (scopeFlag !== "global") {
      const projectsDir = join(MEMORY_DIR, "projects");
      try {
        // New structure: projects/<dir-name>/memory.db
        const dirs = readdirSync(projectsDir).filter((d) => {
          const full = join(projectsDir, d);
          return statSync(full).isDirectory() && existsSync(join(full, "memory.db"));
        });
        for (const dir of dirs) {
          const dbPath = join(projectsDir, dir, "memory.db");
          const db = new Database(dbPath, { readonly: true });
          const rows = db.query("SELECT * FROM memories ORDER BY id").all() as Memory[];
          if (rows.length > 0) {
            result[dir] = rows;
          }
          db.close();
        }
      } catch {
        // projects dir may not exist
      }
    }

    const total = Object.values(result).reduce((s, a) => s + a.length, 0);
    writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`Exported ${total} memories to: ${outputPath}`);
    closeAll();
    break;
  }

  case "import": {
    const filePath = positionalArg();
    if (!filePath) {
      console.error("Usage: bun run src/cli.ts import <file>");
      process.exit(1);
    }

    const data = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, Memory[]>;
    let imported = 0;
    let merged = 0;

    for (const [label, memories] of Object.entries(data)) {
      // label is "global" or a dir-name like "-home-zhangbh-my-app"
      const db = label === "global" ? globalDb() : projectDb("/" + label.replace(/-/g, "/"));
      for (const m of memories) {
        const r = addMemory(
          db,
          m.content,
          (m.category as MemoryCategory) || "general",
          m.tags || null,
          m.importance || 5,
          (m.source as MemorySource) || "auto",
          m.context || null
        );
        if (r.created_at === r.updated_at) {
          imported++;
        } else {
          merged++;
        }
      }
    }

    console.log(`Import complete: ${imported} new, ${merged} merged.`);
    closeAll();
    break;
  }

  default:
    console.error("cursor-memory CLI");
    console.error("");
    console.error("Commands:");
    console.error("  export [output.json]          Export all memories");
    console.error("    --global                    Export only global memories");
    console.error("");
    console.error("  import <file.json>            Import memories from backup");
    console.error("");
    console.error("Examples:");
    console.error("  bun run src/cli.ts export ./backup.json");
    console.error("  bun run src/cli.ts export --global");
    console.error("  bun run src/cli.ts import ./backup.json");
    process.exit(command ? 1 : 0);
}
