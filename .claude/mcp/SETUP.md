# Project MCP Setup for LinearCard

This guide explains how Claude Code loads project-scoped MCP servers, overriding global workspace settings.

## Architecture

Claude Code supports two levels of MCP configuration:

1. **Global** (`~/.claude/mcp.json`) — applies to every project on this machine
2. **Project** (`.mcp.json` in repo root) — applies only to LinearCard

Project settings always take precedence. An MCP server defined in the repo's `.mcp.json` overrides a global server with the same name.

## Current Setup

LinearCard's `.mcp.json` (project root) defines:

```json
{
  "mcpServers": {
    "linearcard-project-context": {
      "command": "node",
      "args": [".claude/mcp/project-context-server.js"],
      "description": "LinearCard project-specific context and configuration",
      "env": {
        "PROJECT_DIR": "."
      }
    }
  }
}
```

This registers `project-context-server.js` from `.claude/mcp/` as a project-level MCP server.

## First Time Setup

1. **Clone/open the repo** in Claude Code
2. **Approve the MCP server** when prompted (one-time approval per machine)
3. **Claude can now access** project-scoped tools and resources

The approval flow is Claude Code's built-in security mechanism — custom MCP servers must be approved before they run.

## Adding More Project MCP Servers

1. Write your server in `.claude/mcp/<name>.js` (implements MCP 2024-11-05 protocol)
2. Add entry to `.mcp.json` in the repo root:
   ```json
   {
     "mcpServers": {
       "my-server": {
         "command": "node",
         "args": [".claude/mcp/my-server.js"]
       }
     }
   }
   ```
3. Restart Claude Code session
4. Approve the new server when prompted
5. Available immediately in that session

## Updating an Existing Server

Edit `.claude/mcp/<name>.js` and restart the Claude Code session — no approval needed, already trusted.

## Disabling a Server

Remove its entry from `.mcp.json` and restart Claude Code. The server is no longer invoked.

## Why Project MCP over Global?

- **Isolation**: LinearCard server runs only in this repo, not every project
- **Control**: Team can version `.mcp.json` with code, keeping scripts in sync
- **Authority**: Project root `.mcp.json` takes precedence — local copy always wins
