#!/usr/bin/env node
/**
 * Project-level MCP Context Server
 * Provides project-specific resources, tools, and configuration
 * Overrides global workspace settings for this project
 */

const fs = require('fs');
const path = require('path');

const projectDir = process.env.PROJECT_DIR || process.cwd();
const claudeDir = path.join(projectDir, '.claude');

// MCP server resources and tools
const resources = {
  'project://rules': {
    uri: `file://${claudeDir}/rules`,
    description: 'Project rules and conventions',
    mimeType: 'text/markdown',
  },
  'project://hooks': {
    uri: `file://${claudeDir}/hooks`,
    description: 'Project hooks and automation',
    mimeType: 'application/json',
  },
  'project://commands': {
    uri: `file://${claudeDir}/commands`,
    description: 'Project slash commands',
    mimeType: 'text/markdown',
  },
  'project://agents': {
    uri: `file://${claudeDir}/agents`,
    description: 'Project subagents',
    mimeType: 'text/markdown',
  },
  'project://skills': {
    uri: `file://${claudeDir}/skills`,
    description: 'Project skills',
    mimeType: 'text/markdown',
  },
};

// Load project configuration
function loadProjectConfig() {
  const configPath = path.join(claudeDir, 'settings.json');
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  return {};
}

// MCP protocol handler
process.stdout.on('drain', () => {});

const config = loadProjectConfig();

// Respond to MCP initialize
process.stdin.on('data', (chunk) => {
  try {
    const request = JSON.parse(chunk.toString());

    if (request.method === 'initialize') {
      const response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            resources: {},
            tools: {},
          },
          serverInfo: {
            name: 'linearcard-project-context',
            version: '1.0.0',
          },
        },
      };
      process.stdout.write(JSON.stringify(response) + '\n');
    } else if (request.method === 'resources/list') {
      const response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          resources: Object.entries(resources).map(([key, val]) => ({
            uri: val.uri,
            name: key,
            description: val.description,
            mimeType: val.mimeType,
          })),
        },
      };
      process.stdout.write(JSON.stringify(response) + '\n');
    } else if (request.method === 'resources/read') {
      const uri = request.params?.uri;
      let content = '';

      if (uri === `file://${claudeDir}/rules`) {
        const rulesReadme = path.join(claudeDir, 'rules', 'README.md');
        if (fs.existsSync(rulesReadme)) {
          content = fs.readFileSync(rulesReadme, 'utf8');
        }
      }

      const response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          contents: [
            {
              uri: uri,
              mimeType: 'text/markdown',
              text: content,
            },
          ],
        },
      };
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  } catch (err) {
    // Silently handle parse errors
  }
});

// Keep process alive
process.stdin.resume();
