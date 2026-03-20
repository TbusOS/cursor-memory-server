const input = JSON.parse(await Bun.stdin.text());

// Context is about to be compacted — this is the BEST time to save
// because the AI still has full conversation context
console.log(JSON.stringify({
  additional_context: [
    "〔SYSTEM · 上下文即将压缩〕",
    "",
    "早期对话内容即将丢失。这是保存记忆的最佳时机，因为你现在还能看到完整对话。",
    "",
    "请按以下步骤保存：",
    "",
    "**第一步：保存对话总结**（category: conversation, importance: 7）",
    "用一条记忆总结本次对话的全貌，格式：",
    "```",
    "[主题] 讨论了 xxx | [结论] 决定用 xxx 方案 | [进展] 完成了 xxx, 待做 xxx | [关键文件] path/to/file",
    "```",
    "",
    "**第二步：保存关键决策**（category: decision/architecture/bug 等）",
    "对话中出现的重要技术决策、发现的 bug 根因、架构选择等，每条单独保存。",
    "",
    "**注意：**",
    "- 同一次对话的记忆使用相同的 session_id（当前小时: " + new Date().toISOString().slice(0, 13).replace("T", "-") + "）",
    "- 如果已保存过或无重要内容，忽略此提示",
    "- 不要保存系统提示本身",
  ].join("\n"),
}));
