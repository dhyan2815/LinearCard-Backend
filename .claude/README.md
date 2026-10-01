# Claude Code Project Configuration

This directory holds project-scoped customization for LinearCard. Every file here overrides global workspace settings when Claude Code runs in this repo.

## Directory Structure

```
.claude/
├── README.md                    # This file — overview
├── settings.json               # Project settings (hooks, MCP approvals, etc.)
├── agents/                     # Custom subagents for this project
│   ├── README.md              # How to add subagents
│   ├── code-reviewer.md       # Code review agent
│   └── tenant-isolation-auditor.md  # Tenant isolation auditor
├── commands/                   # Slash commands (/cmd)
│   ├── README.md              # How to add commands
│   └── *.md                   # Individual command definitions
├── hooks/                      # Lifecycle hooks (guaranteed enforcement)
│   ├── README.md              # How hooks work vs. rules
│   ├── no-attribution.js      # Git commit/PR attribution blocker
│   └── *.py, *.sh, *.json    # Other hooks
├── mcp/                        # MCP (Model Context Protocol) servers
│   ├── SETUP.md               # Project-level MCP configuration guide
│   ├── README.md              # MCP server overview
│   └── project-context-server.js  # Example MCP server
├── rules/                      # Rules and conventions (guidance, not enforcement)
│   ├── README.md              # Rule files index
│   ├── git.md                 # Git commit rules
│   ├── backend.md             # NestJS backend patterns
│   ├── frontend.md            # Next.js frontend patterns
│   ├── env-variables.md       # Environment variable reference
│   ├── coding_standards.md    # Coding standards across languages
│   └── naming_conventions.md  # Naming conventions
├── skills/                     # Reusable workflows
│   ├── git-smart-commit/
│   │   ├── SKILL.md           # Skill definition
│   │   └── README.md          # How it works
│   └── ...
└── worktrees/                 # Git worktrees (created at runtime)
```

## How It Works

### 1. Rules (`.claude/rules/`)
**Guidance only** — Claude reads these as context but can override them. Use for patterns, conventions, and best practices.

Entry points:
- Root `CLAUDE.md` links to `.claude/rules/`
- Claude loads them automatically per session

Examples:
- Backend patterns (tenant isolation, pass issuance)
- Frontend conventions (route structure, `useDashboard()`)
- Coding standards (Python/TypeScript/Go naming)

### 2. Hooks (`.claude/hooks/`)
**Guaranteed enforcement** — the harness runs these at lifecycle events, independent of Claude's choices. Use for security-critical policies.

Current hooks:
- `no-attribution.js` — Fires on `git commit`/`gh pr create`, blocks co-authored attribution lines
- Other hooks for secrets detection, dependency checks, etc.

Wired in `settings.json` under `hooks` key.

### 3. Agents (`.claude/agents/`)
**Specialized subagents** that run in their own context windows. Use when a task is heavy enough that its output shouldn't clutter the main thread.

- `code-reviewer.md` — Reviews code against standards
- `tenant-isolation-auditor.md` — Audits backend for multi-tenant bugs

Invoked via `Agent({ subagent_type: "name" })` or proactively after code changes.

### 4. Commands (`.claude/commands/`)
**Slash commands** that users trigger with `/cmd`. Each defines its own scope and allowed tools.

- `/code-quality <dir>` — Static review
- `/pr-review <pr>` — GitHub PR review
- `/ticket <id>` — End-to-end ticket workflow

### 5. Skills (`.claude/skills/`)
**Reusable workflows** that can be invoked across sessions. Use for repetitive multi-step tasks.

- `/git-smart-commit` — Analyze changes, group logically, commit with style-matching messages

### 6. MCP Servers (`.claude/mcp/`)
**Project-scoped Model Context Protocol** servers that extend Claude with tools and resources.

Configuration:
- Defined in `.mcp.json` (project root, not in `.claude/`)
- Approved one-time per machine
- Override global workspace MCP servers

Entry point:
- See `.claude/mcp/SETUP.md` for configuration guide

## Priority & Composition

**Settings hierarchy** (highest to lowest):
1. `.claude/settings.json` (this project)
2. `~/.claude/settings.json` (user-level, all projects)
3. Managed settings (organization policy)

**Rules loading** (merged):
- Root `CLAUDE.md` (points to `.claude/rules/`)
- `.claude/rules/*.md` (loaded automatically)
- All rules compose; conflicts resolved by context

**Hooks** (all run):
- All hooks in `.claude/hooks/` that match the lifecycle event fire in sequence
- Enforced regardless of Claude's preferences
- Wired in `settings.json`

## Updating Configuration

### To add a rule
1. Create `.claude/rules/topic.md`
2. Link it from root `CLAUDE.md` or it auto-loads
3. Next session reads it automatically

### To add a hook
1. Create `.claude/hooks/my-hook.{js,py,sh}`
2. Wire it in `.claude/settings.json` under `hooks`
3. Hook fires on specified lifecycle event

### To add a command
1. Create `.claude/commands/my-command.md` with frontmatter
2. Invoke with `/my-command <args>`
3. Can restrict tools in frontmatter's `allowed-tools`

### To add an agent
1. Create `.claude/agents/my-agent.md` with frontmatter
2. Invoke via `Agent({ subagent_type: "my-agent" })`
3. Can specify model, tools, and description in frontmatter

### To add an MCP server
1. Create `.claude/mcp/my-server.js` (MCP 2024-11-05 protocol)
2. Add entry to `.mcp.json` in repo root
3. Restart Claude Code and approve when prompted

## See Also

- `CLAUDE.md` (repo root) — Quick commands, architecture overview
- `.claude/rules/git.md` — No-attribution-lines rule (enforced by hook)
- `.claude/mcp/SETUP.md` — Project MCP configuration details
- Root `AGENTS.md` — Next.js 16 API notes for new code

## Design Principles

1. **Least privilege** — Commands, agents, hooks only get the tools they need
2. **Clarity over cleverness** — Read-friendly YAML, JSON, and Markdown, not dense code
3. **Composable** — Rules merge, hooks stack, commands are reusable
4. **Reversible** — Delete a file to disable it; no scattered state
5. **Durable** — Checked into git; team consistency across machines
