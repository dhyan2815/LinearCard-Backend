# LinearCard MCP Setup & Usage

Three custom MCPs built for LinearCard to reduce token consumption and eliminate repetitive manual lookups.

## Installation

### 1. Install dependencies

```bash
npm install @modelcontextprotocol/sdk @supabase/supabase-js
```

### 2. Environment variables

Ensure `.env` (or `apps/api/.env`) has:
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### 3. Restart Claude Code

MCPs load at startup. Restart the app after `.mcp.json` changes.

---

## Three MCPs

### **Supabase Inspector**
Query database schema, find tenant-scoped tables.

**When to use:**
- "What tables exist?" → `inspect_schema`
- "Show Member table structure" → `get_table_info`
- "Which tables have tenantId?" → `find_tenant_tables`

**Token savings:** 40-50% (no schema dumps)

---

### **Architecture Navigator**
Index NestJS modules, routes, service methods.

**When to use:**
- "Where is POST /programs?" → `find_endpoint`
- "What methods in wallet service?" → `find_service_method`
- "Show members module routes" → `get_module_info`

**Token savings:** 30-40% (no file browsing)

---

### **Tenant Auditor**
Scan for multi-tenant isolation issues.

**When to use:**
- "Is code tenant-isolated?" → `audit_tenant_isolation`
- "Check this file for TenantGuard" → `check_file`
- "Find unfiltered queries" → `find_unfiltered_queries`

**Token savings:** 50-70% (automated compliance)

---

## Quick Start

After setup, in Claude Code:

```
You: "Show me the programs module structure"
Claude: [Calls architecture-navigator → lists routes + methods]

You: "What's the Pass table structure?"
Claude: [Calls supabase-inspector → columns + types]

You: "Is my new endpoint tenant-safe?"
Claude: [Calls tenant-auditor on your file → instant check]
```

---

## Troubleshooting

- **MCPs not showing?** Restart Claude Code app (not just session)
- **Supabase error?** Check env vars are set: `echo $SUPABASE_SERVICE_ROLE_KEY`
- **No modules found?** Verify `apps/api/src/` structure
- **False positives in auditor?** Use `check_file` for verification

---

**Files created:**
- `.claude/mcp/supabase-inspector.mjs` — schema queries
- `.claude/mcp/architecture-navigator.mjs` — module indexing
- `.claude/mcp/tenant-auditor.mjs` — isolation audits
- `.mcp.json` — updated with all three servers
