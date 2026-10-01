#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
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
  { name: "tenant-auditor", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

function walkDir(dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      files.push(...walkDir(fullPath));
    } else if (entry.isFile() && fullPath.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function analyzeFile(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const findings = {
    file: path.relative(PROJECT_ROOT, filePath),
    queries: [],
    issues: [],
  };

  // Patterns to check
  const supabaseQueryPatterns = [
    /\.from\s*\(\s*['"`](\w+)['"`]\s*\)/g,
    /\.select\s*\(/g,
    /\.insert\s*\(/g,
    /\.update\s*\(/g,
    /\.delete\s*\(/g,
  ];

  const tenantFilterPatterns = [
    /\.eq\s*\(\s*['"`]tenantId['"`]\s*,\s*(\w+)\s*\)/,
    /\.match\s*\(\s*['"`]tenantId['"`]/,
    /WHERE.*tenantId/i,
  ];

  // Find all queries
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect .from() calls
    if (line.includes(".from(")) {
      const tableMatch = line.match(/\.from\s*\(\s*['"`](\w+)['"`]\s*\)/);
      if (tableMatch) {
        // Check if next few lines have tenantId filter
        const nextLines = lines.slice(i, Math.min(i + 5, lines.length)).join(" ");
        const hasTenantFilter = tenantFilterPatterns.some((p) =>
          p.test(nextLines)
        );

        findings.queries.push({
          line: i + 1,
          table: tableMatch[1],
          snippet: line.trim().substring(0, 60),
          hasTenantFilter,
        });

        if (!hasTenantFilter) {
          findings.issues.push({
            line: i + 1,
            severity: "HIGH",
            message: `Query on '${tableMatch[1]}' missing tenantId filter`,
            snippet: line.trim(),
          });
        }
      }
    }

    // Detect service-role client usage without explicit tenant check
    if (
      line.includes("this.supabaseService.client") ||
      line.includes(".from(")
    ) {
      if (line.includes("forTenant")) {
        // RLS client - OK
      } else if (!line.includes(".eq('tenantId'")) {
        const tableMatch = line.match(/\.from\s*\(\s*['"`](\w+)['"`]\s*\)/);
        if (tableMatch) {
          findings.issues.push({
            line: i + 1,
            severity: "MEDIUM",
            message: `Service-role query on '${tableMatch[1]}' - verify tenantId filtering`,
            snippet: line.trim(),
          });
        }
      }
    }

    // Detect unguarded routes
    if (
      (line.includes("@Get(") ||
        line.includes("@Post(") ||
        line.includes("@Put(") ||
        line.includes("@Patch(") ||
        line.includes("@Delete(")) &&
      !line.includes("TenantGuard")
    ) {
      // Check if TenantGuard is on class or method
      let hasGuard = false;
      for (let j = Math.max(0, i - 5); j <= i; j++) {
        if (lines[j].includes("@UseGuards(TenantGuard)")) {
          hasGuard = true;
          break;
        }
      }
      if (!hasGuard) {
        findings.issues.push({
          line: i + 1,
          severity: "HIGH",
          message: "Unguarded route - missing @UseGuards(TenantGuard)",
          snippet: line.trim(),
        });
      }
    }
  }

  return findings;
}

function auditFullProject() {
  const allFindings = {
    timestamp: new Date().toISOString(),
    files_scanned: 0,
    total_queries: 0,
    issues_found: [],
    safe_files: [],
  };

  try {
    const files = walkDir(API_SRC);
    allFindings.files_scanned = files.length;

    for (const file of files) {
      const findings = analyzeFile(file);
      allFindings.total_queries += findings.queries.length;

      if (findings.issues.length > 0) {
        allFindings.issues_found.push({
          file: findings.file,
          issues: findings.issues,
        });
      } else if (findings.queries.length > 0) {
        allFindings.safe_files.push(findings.file);
      }
    }
  } catch (error) {
    console.error(`Audit error: ${error.message}`);
  }

  return allFindings;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "audit_tenant_isolation",
      description:
        "Full project audit: scan all backend code for multi-tenant isolation issues (missing tenantId filters, unguarded routes, etc.)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "check_file",
      description: "Analyze a specific file for tenant isolation issues",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description:
              "Relative path from project root, e.g., 'src/members/members.controller.ts'",
          },
        },
        required: ["file_path"],
      },
    },
    {
      name: "find_unfiltered_queries",
      description:
        "Find all database queries that lack explicit tenantId filtering",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "check_guarded_routes",
      description:
        "Verify all API routes have @UseGuards(TenantGuard) decorator",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "audit_tenant_isolation") {
      const audit = auditFullProject();
      const summary =
        audit.issues_found.length === 0
          ? `✅ Multi-tenant audit passed!\n\nScanned ${audit.files_scanned} files, ${audit.total_queries} queries.\n${audit.safe_files.length} files with safe patterns.`
          : `⚠️ Found ${audit.issues_found.length} file(s) with isolation issues:\n\n${audit.issues_found
              .map(
                (f) =>
                  `${f.file}:\n${f.issues
                    .map((i) => `  Line ${i.line} [${i.severity}] ${i.message}`)
                    .join("\n")}`
              )
              .join("\n\n")}`;

      return {
        content: [{ type: "text", text: summary }],
      };
    }

    if (name === "check_file") {
      const fullPath = path.join(PROJECT_ROOT, args.file_path);
      if (!fs.existsSync(fullPath)) {
        return {
          content: [{ type: "text", text: `File not found: ${args.file_path}` }],
          isError: true,
        };
      }

      const findings = analyzeFile(fullPath);
      const text =
        findings.issues.length === 0
          ? `✅ File looks safe (${findings.queries.length} queries, all filtered)`
          : `⚠️ Found ${findings.issues.length} issue(s):\n${findings.issues
              .map((i) => `Line ${i.line}: ${i.message}\n  ${i.snippet}`)
              .join("\n\n")}`;

      return {
        content: [{ type: "text", text }],
      };
    }

    if (name === "find_unfiltered_queries") {
      const audit = auditFullProject();
      const unfiltered = audit.issues_found
        .flatMap((f) =>
          f.issues
            .filter((i) => i.message.includes("tenantId filter"))
            .map((i) => ({ file: f.file, ...i }))
        );

      return {
        content: [
          {
            type: "text",
            text:
              unfiltered.length === 0
                ? `✅ No unfiltered queries found (${audit.total_queries} queries scanned)`
                : `Found ${unfiltered.length} unfiltered queries:\n${unfiltered
                    .map((q) => `${q.file}:${q.line} - ${q.message}`)
                    .join("\n")}`,
          },
        ],
      };
    }

    if (name === "check_guarded_routes") {
      const audit = auditFullProject();
      const unguarded = audit.issues_found
        .flatMap((f) =>
          f.issues
            .filter((i) => i.message.includes("TenantGuard"))
            .map((i) => ({ file: f.file, ...i }))
        );

      return {
        content: [
          {
            type: "text",
            text:
              unguarded.length === 0
                ? "✅ All routes appear to be guarded"
                : `Found ${unguarded.length} potentially unguarded routes:\n${unguarded
                    .map((q) => `${q.file}:${q.line} - ${q.message}`)
                    .join("\n")}`,
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
console.error("Tenant Auditor MCP running");
