# git-smart-commit

Skill, invoked as `/git-smart-commit` (see `SKILL.md`). Scans `git status`, groups uncommitted changes into 1–3 logical commits, drafts messages matching this repo's observed commit style, stages/commits each group, and pushes to origin — no planning back-and-forth, runs the sequence directly.

## Notes

- Commit messages must **not** include `Co-Authored-By` or "Generated with Claude Code" lines — see `.claude/rules/git.md`. This is enforced independently by the `no-attribution.js` `PreToolUse` hook (`.claude/hooks/`), which fires on any `git commit`/`gh pr create` regardless of which skill triggers it.
- Stages files individually (`git add <file>`), never `git add .` / `-A`.
- Grouping favors few, cohesive commits (docs vs. implementation) over one monolithic commit or one-file-per-commit.
