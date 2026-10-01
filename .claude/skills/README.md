# Skills

Project skills for the `Skill` tool. Each `<name>/SKILL.md` is invoked via `/<name>` or auto-triggered by its `description`.

## Files

- `git-smart-commit/` — scans uncommitted changes, groups into logical commits matching repo message style, pushes.
- `api-endpoint-scaffolder/` — wires a new NestJS route end-to-end (controller + `TenantGuard`, shared types, frontend `apiClient` call), with the tenant-scoping checklist baked in.
- `dashboard-page-scaffolder/` — adds a program-scoped or account-level page in `apps/web/app/dashboard`, wiring nav and `useDashboard()` correctly.

## Adding a skill

1. New `<name>/SKILL.md` with frontmatter: `name`, `description` (specific — this is what triggers auto-invocation).
2. Reference `.claude/rules/*.md` and `CLAUDE.md` rather than duplicating their content — skills should encode the *procedure*, rules encode the *facts*.
3. Document it here in one line.
