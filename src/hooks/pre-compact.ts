const input = JSON.parse(await Bun.stdin.text());

// Context is about to be compacted — important unsaved info may be lost
console.log(JSON.stringify({
  additional_context: [
    "[Memory System] ⚠️ 上下文即将被压缩，早期对话内容将丢失。",
    "请立即检查本次对话中是否有尚未保存的重要信息（技术决策、架构选择、用户偏好、关键 bug 等）。",
    "如有，请在压缩前调用 memory_add 保存。如无则忽略。",
  ].join("\n"),
}));
