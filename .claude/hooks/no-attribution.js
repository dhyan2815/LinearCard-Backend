#!/usr/bin/env node
// PreToolUse hook: injects a reminder before any Bash command that runs `git commit` or `gh pr create`.
const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.exit(0);
  }

  const command = input?.tool_input?.command || '';
  const isCommit = /\bgit\s+commit\b/.test(command);
  const isPr = /\bgh\s+pr\s+create\b/.test(command);

  if (!isCommit && !isPr) process.exit(0);

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          'Repo rule (LinearCard): do NOT add Co-Authored-By or "Generated with Claude Code" lines to this commit message / PR description. Commit/PR body = summary and description only.',
      },
    }),
  );
  process.exit(0);
});