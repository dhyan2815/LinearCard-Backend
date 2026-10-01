#!/usr/bin/env node
// UserPromptSubmit hook: matches the user's prompt against keyword sets for
// each file in .claude/rules/, and points the agent at any rule files whose
// area the prompt just touched. Fails open (exits 0, no context) on any error
// or when nothing matches, so it never blocks a prompt.
//
// This does NOT dump rule file contents into context on every matching prompt
// -- the rules already load via CLAUDE.md's pointers for backend.md/frontend.md,
// and dumping naming_conventions.md/coding_standards.md (both long) on every
// hit would be the most expensive context this hook could add. Instead it
// names the specific file(s) and asks the agent to read them, which is a
// single line of injected context regardless of how big the target file is.
const fs = require('fs');
const path = require('path');

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const prompt = input?.prompt || '';
    if (!prompt.trim()) process.exit(0);

    const projectDir = process.env.CLAUDE_PROJECT_DIR || input?.cwd || '.';
    const configPath = path.join(projectDir, '.claude', 'hooks', 'rules-context.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    const lower = prompt.toLowerCase();
    const hits = [];

    for (const [file, entry] of Object.entries(config)) {
      const matched = entry.keywords.some((kw) => {
        try {
          return new RegExp(kw, 'i').test(lower);
        } catch {
          return lower.includes(kw.toLowerCase());
        }
      });
      if (matched) hits.push({ file, description: entry.description });
    }

    if (hits.length === 0) process.exit(0);

    const lines = hits.map((h) => `- \`.claude/rules/${h.file}\` — ${h.description}`);
    const context =
      `This query touches an area covered by a project rule file. Read the relevant one(s) before making changes:\n` +
      lines.join('\n');

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: context,
        },
      }),
    );
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
