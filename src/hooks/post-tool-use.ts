import { existsSync } from "fs";
import { join, dirname } from "path";

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  const markers = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".svn", "pom.xml", "build.gradle"];
  for (let i = 0; i < 10; i++) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

const input = JSON.parse(await Bun.stdin.text());

const toolName: string = input.tool_name || "";
const toolInput = input.tool_input || {};

// Only care about memory_* MCP calls
if (!toolName.startsWith("memory_")) {
  console.log(JSON.stringify({}));
  process.exit(0);
}

let message = "";

if (toolName === "memory_add") {
  const scope = toolInput.scope || "project";
  const content: string = toolInput.content || "";
  const summary = content.length > 60 ? content.slice(0, 60) + "..." : content;

  if (scope === "shared") {
    const root = findProjectRoot(process.cwd());
    const dbPath = join(root, ".cursor", "memory", "shared.db");
    message = `💾 已记住 [shared]: ${summary}\n📁 团队共享记忆已保存到: ${dbPath}\n提示用户 git add 此文件以与团队共享。`;
  } else {
    message = `💾 已记住 [${scope}]: ${summary}`;
  }
} else if (toolName === "memory_delete") {
  const scope = toolInput.scope || "project";
  const id = toolInput.id;
  message = `🗑️ 已删除记忆 [#${id}][${scope}]`;
} else if (toolName === "memory_update") {
  const scope = toolInput.scope || "project";
  const id = toolInput.id;
  const content: string = toolInput.content || "";
  const summary = content ? (content.length > 60 ? content.slice(0, 60) + "..." : content) : "（内容未变）";
  message = `✏️ 已更新记忆 [#${id}][${scope}]: ${summary}`;
} else {
  // memory_search, memory_list, memory_get_context — no notification needed
  console.log(JSON.stringify({}));
  process.exit(0);
}

console.log(JSON.stringify({
  additional_context: `[Memory System] 请在回复末尾用一行通知用户：${message}`,
}));
