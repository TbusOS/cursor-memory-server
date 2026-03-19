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
    "Session ending. Review what happened and save key takeaways using memory_add if anything is worth remembering.",
    "",
    "Worth saving: decisions made, architecture choices, bugs found and solutions, significant progress, user preferences.",
    "NOT worth saving: trivial changes, temporary debug attempts, incomplete discussions.",
    "",
    "If nothing important happened, just say 'nothing to save' and stop.",
  ].join("\n"),
}));
