# Project MCP Servers

Project-level Model Context Protocol (MCP) server definitions for LinearCard.

## Configuration

Claude Code loads MCP servers from two sources:
1. **Global workspace** — `~/.claude/mcp.json` (applies to all projects)
2. **Project-level** — `.mcp.json` in the project root (overrides global for this project only)

To configure project-specific MCP servers for LinearCard, create/edit `.mcp.json` in the repository root:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": [".claude/mcp/my-server.js"],
      "description": "Project-specific MCP server"
    }
  }
}
```

Claude Code will:
1. Discover `.mcp.json` at project startup
2. Prompt for approval (one-time per server)
3. Launch the MCP server when needed
4. Serve resources/tools to Claude in this session

## Files

- `project-context-server.js` — Starter template for a project MCP server. Implements MCP 2024-11-05 protocol.

## Example: Adding a project MCP server

1. Write your server in `.claude/mcp/` (e.g., `my-server.js`)
2. Add entry to `.mcp.json` in the repo root (not in `.claude/`)
3. Restart Claude Code
4. Approve the server when prompted
5. Claude can now call its tools/resources in this project

## When to use project MCP

- Project-specific tools (monorepo helpers, domain-specific CLIs)
- Local knowledge bases or databases
- Custom resource providers that shouldn't be global
