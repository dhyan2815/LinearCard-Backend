#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, "../../");
const API_SRC = path.join(PROJECT_ROOT, "src");

const server = new Server(
  { name: "architecture-navigator", version: "1.0.0" },
  { capabilities: { resources: {}, tools: {} } },
);

let architectureIndex = null;

function walkDir(dir, ext) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      files.push(...walkDir(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractRoutes(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const routes = [];

  // Match @Get/@Post/@Put/@Patch/@Delete decorators
  const methodRegex =
    /@(Get|Post|Put|Patch|Delete)\s*\(\s*['"`]([^'"`]*?)['"`]\s*\)/g;
  let match;
  while ((match = methodRegex.exec(content)) !== null) {
    routes.push({
      method: match[1],
      path: match[2],
      file: path.relative(PROJECT_ROOT, filePath),
    });
  }

  return routes;
}

function extractServiceMethods(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const methods = [];

  // Match public methods
  const methodRegex =
    /(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w+(?:<[^>]*>)?|{)/g;
  let match;
  while ((match = methodRegex.exec(content)) !== null) {
    if (match[1] !== "constructor" && !match[1].startsWith("_")) {
      methods.push(match[1]);
    }
  }

  return [...new Set(methods)];
}

function buildIndex() {
  const modules = {};

  try {
    const moduleDirs = fs
      .readdirSync(API_SRC)
      .filter(
        (f) =>
          fs.statSync(path.join(API_SRC, f)).isDirectory() &&
          !f.startsWith(".")
      );

    for (const moduleName of moduleDirs) {
      const modulePath = path.join(API_SRC, moduleName);
      const controllerFile = path.join(modulePath, `${moduleName}.controller.ts`);
      const serviceFile = path.join(modulePath, `${moduleName}.service.ts`);

      modules[moduleName] = {
        path: modulePath,
        routes: [],
        serviceMethods: [],
      };

      if (fs.existsSync(controllerFile)) {
        modules[moduleName].routes = extractRoutes(controllerFile);
      }

      if (fs.existsSync(serviceFile)) {
        modules[moduleName].serviceMethods = extractServiceMethods(serviceFile);
      }
    }
  } catch (error) {
    console.error(`Failed to build index: ${error.message}`);
  }

  return modules;
}

function getArchitecture() {
  if (!architectureIndex) {
    architectureIndex = buildIndex();
  }
  return architectureIndex;
}

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "linearcard://architecture",
      name: "LinearCard Architecture Index",
      description: "All NestJS modules, routes, and service methods",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === "linearcard://architecture") {
    const arch = getArchitecture();
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(arch, null, 2),
        },
      ],
    };
  }
  throw new Error("Unknown resource");
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_modules",
      description: "List all NestJS modules in the backend",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "find_endpoint",
      description:
        'Find endpoint by method (GET, POST, etc.) and partial path (e.g., "programs", "/members/:id")',
      inputSchema: {
        type: "object",
        properties: {
          method: {
            type: "string",
            description: "HTTP method (GET, POST, PUT, PATCH, DELETE)",
          },
          path_pattern: {
            type: "string",
            description: "Partial path to search (e.g., 'programs', 'members')",
          },
        },
        required: ["method"],
      },
    },
    {
      name: "get_module_info",
      description: "Get all routes and service methods for a specific module",
      inputSchema: {
        type: "object",
        properties: {
          module_name: {
            type: "string",
            description: "Module name (e.g., 'programs', 'members', 'passes')",
          },
        },
        required: ["module_name"],
      },
    },
    {
      name: "find_service_method",
      description:
        "Find which service contains a specific method (e.g., issueForMember)",
      inputSchema: {
        type: "object",
        properties: {
          method_name: {
            type: "string",
            description: "Service method name to find",
          },
        },
        required: ["method_name"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const arch = getArchitecture();

  try {
    if (name === "list_modules") {
      const modules = Object.keys(arch).sort();
      const summary = modules.map((m) => ({
        module: m,
        routes: arch[m].routes.length,
        methods: arch[m].serviceMethods.length,
      }));
      return {
        content: [
          {
            type: "text",
            text: `NestJS Modules (${modules.length}):\n\n${summary
              .map((m) => `${m.module}: ${m.routes} routes, ${m.methods} service methods`)
              .join("\n")}`,
          },
        ],
      };
    }

    if (name === "find_endpoint") {
      const results = [];
      for (const [moduleName, moduleInfo] of Object.entries(arch)) {
        for (const route of moduleInfo.routes) {
          if (
            route.method === args.method &&
            (!args.path_pattern || route.path.includes(args.path_pattern))
          ) {
            results.push({ module: moduleName, ...route });
          }
        }
      }
      return {
        content: [
          {
            type: "text",
            text:
              results.length > 0
                ? `Found ${results.length} endpoint(s):\n${results
                    .map((r) => `${r.method} ${r.path} (${r.module})`)
                    .join("\n")}`
                : `No endpoints found for ${args.method} ${args.path_pattern || "*"}`,
          },
        ],
      };
    }

    if (name === "get_module_info") {
      const info = arch[args.module_name];
      if (!info) {
        return {
          content: [
            {
              type: "text",
              text: `Module '${args.module_name}' not found. Available: ${Object.keys(arch).join(", ")}`,
            },
          ],
        };
      }

      const routeText =
        info.routes.length > 0
          ? `Routes:\n${info.routes.map((r) => `  ${r.method} ${r.path}`).join("\n")}`
          : "No routes";

      const methodText =
        info.serviceMethods.length > 0
          ? `\n\nService Methods:\n${info.serviceMethods.map((m) => `  - ${m}()`).join("\n")}`
          : "";

      return {
        content: [
          {
            type: "text",
            text: `Module: ${args.module_name}\n${routeText}${methodText}`,
          },
        ],
      };
    }

    if (name === "find_service_method") {
      const results = [];
      for (const [moduleName, moduleInfo] of Object.entries(arch)) {
        if (moduleInfo.serviceMethods.includes(args.method_name)) {
          results.push(moduleName);
        }
      }

      return {
        content: [
          {
            type: "text",
            text:
              results.length > 0
                ? `Method '${args.method_name}' found in: ${results.join(", ")}`
                : `Method '${args.method_name}' not found in any service`,
          },
        ],
      };
    }

    return { content: [{ type: "text", text: "Unknown tool" }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Architecture Navigator MCP running");
