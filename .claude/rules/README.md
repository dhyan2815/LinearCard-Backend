# Rules

Reference docs auto-loaded into every Claude Code session in this repo (via root `CLAUDE.md`'s pointers, and directly for `naming_conventions.md`/`coding_standards.md`). These are read as context, not executed — unlike `hooks/`, nothing here is enforced by code. Keep the fix in a hook if it must never be skipped.

## Files

- `backend.md` — NestJS/`apps/api` conventions: module map, tenant-scoping pattern, Google Wallet, pass issuance, outbound webhooks, security (OTP, sessions, API keys), test commands.
- `frontend.md` — Next.js/`apps/web` conventions: route map, `apiClient` usage, `DashboardContext`, how to add a page, known gotchas (Wallet save links, `NEXT_PUBLIC_*` baking, Next 16 async `params`).
- `env-variables.md` — Exhaustive env var reference for both apps: required vs optional, load order, Google Wallet credential resolution, RLS read path, local dev example.
- `git.md` — No co-authorship/attribution lines in commit messages or PR descriptions, ever. Backed by the `no-attribution.js` hook in `.claude/hooks/`.
- `coding_standards.md` — Language-agnostic style guide (Python/JS/TS/Go/Java/C): formatting, error handling, testing conventions, anti-patterns, review checklist.
- `naming_conventions.md` — Naming conventions across files, classes, functions, variables, DB schema, API endpoints, tests.

## Adding a rule

- Repo-specific pattern (this codebase's architecture, a workspace's commands) → new file here, one topic per file, and link it from root `CLAUDE.md`.
- Must hold even if the model ignores it → that's a hook (`.claude/hooks/`), not a rule.
- Update this README's file list when adding or removing one.
