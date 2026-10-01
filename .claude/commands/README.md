# Commands

Slash commands. Each `.md` file here is invoked as `/<filename-without-.md> [args]`. Frontmatter's `allowed-tools` scopes exactly what that command can call — keep it tight so a command can't silently do more than its name implies.

## Files

- `code-quality.md` — `/code-quality <dir>`. Static review of code quality in a directory (Read/Glob/Grep + `npm`/`npx`, no edits).
- `docs-sync.md` — `/docs-sync`. Diffs docs against current code to flag stale documentation.
- `onboard.md` — `/onboard <context>`. Produces an onboarding brief from given context (ticket, repo area, etc.) so a fresh session doesn't start from zero.
- `pr-review.md` — `/pr-review <pr>`. Reviews a pull request against project standards using `git`/`gh`.
- `pr-summary.md` — `/pr-summary`. Generates a PR description from the current branch's changes.
- `ticket.md` — `/ticket <id>`. End-to-end ticket workflow: read the ticket (Jira/Linear MCP), implement, commit, open PR.

## Adding a command

1. New `<name>.md`. Frontmatter: `description` (shown in the picker) and `allowed-tools` (least privilege — e.g. `Bash(git:*)` not bare `Bash`).
2. Reference `$ARGUMENTS` in the body for whatever the user passes after the command name.
3. Add a one-line entry above.
