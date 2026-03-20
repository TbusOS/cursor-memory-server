const input = JSON.parse(await Bun.stdin.text());

// Stop hook fires after EVERY AI response, not just conversation end.
// Using followup_message here would disrupt every interaction with
// memory-save prompts — terrible UX.
//
// Memory saving is handled by:
// 1. Skill instructions: AI saves proactively during conversation
// 2. preCompact hook: saves before context compression (safety net)
//
// This hook is kept as a no-op placeholder for future use.

console.log(JSON.stringify({}));
