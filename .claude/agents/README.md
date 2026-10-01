# Agents

Subagent definitions for the `Agent` tool. Each `.md` file here is a named agent Claude Code can spawn with `Agent({ subagent_type: "<filename-without-.md>" })`. Frontmatter (`name`, `description`, `model`, `allowed-tools`/`tools`) controls when the router considers it and what it can touch; the body is the system prompt that agent runs under.

## Why this exists

A subagent runs in its own context window. Spawning one instead of doing the work inline keeps large tool output (diffs, logs, search results) out of the main conversation — useful for reviews or research that would otherwise bloat context for no lasting benefit.

## Files

- `code-reviewer.md` — reviews a diff against this repo's standards (TypeScript strict mode, tenant-isolation rules in `.claude/rules/backend.md`, naming conventions). Triggered proactively after code changes; runs `git diff` first, reports Critical/Warning/Suggestion findings with line references.
- `tenant-isolation-auditor.md` — audits Supabase queries/routes in `apps/api` for missing `tenantId` filters, trusted-input tenant ids, and wrong HTTP error codes. Triggered proactively after backend changes touching queries or controllers.

## Adding an agent

1. New `<name>.md` with frontmatter: `name`, `description` (be specific — the router matches on this), optional `model`, optional tool restrictions.
2. Keep the body scoped to one job. An agent that tries to do everything defeats the purpose of a specialized context.
3. Document it in this README in one line, same format as above.
