const input = JSON.parse(await Bun.stdin.text());

// Prevent loop: if loop_count > 0, this is already a followup round — exit
if (input.loop_count > 0) {
  console.log(JSON.stringify({}));
  process.exit(0);
}

// Only prompt save on normal completion, not on error/interrupt
if (input.status !== "completed") {
  console.log(JSON.stringify({}));
  process.exit(0);
}

console.log(JSON.stringify({
  followup_message: [
    "对话即将结束。回顾一下本次对话，如果有任何下次对话时可能有用的信息，用 memory_add 保存。",
    "",
    "用你自己的判断——如果觉得'下次对话时知道这个会有帮助'，就保存。不限于特定类别。",
    "如果本次对话没有值得记住的内容，直接说'无需保存'即可。",
  ].join("\n"),
}));
