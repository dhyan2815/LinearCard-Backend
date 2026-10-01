#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, "../../");
// Root .env first (repo convention: root wins over .env), then .env as fallback.
loadEnv({ path: path.join(PROJECT_ROOT, ".env") });
loadEnv({ path: path.join(PROJECT_ROOT, ".env") });

const server = new Server(
  { name: "supabase-inspector", version: "1.0.0" },
  { capabilities: { resources: {}, tools: {} } },
);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
let schemaCache = null;
let cacheTime = 0;

async function getSchema() {
  const now = Date.now();
  if (schemaCache && now - cacheTime < 300000) return schemaCache; // 5 min cache

  const { data: tables, error } = await supabase
    .from("information_schema.tables")
    .select("table_name, table_schema")
    .eq("table_schema", "public");

  if (error) throw new Error(`Failed to fetch tables: ${error.message}`);

  const schema = {};
  for (const table of tables) {
    const { data: columns } = await supabase
      .from("information_schema.columns")
      .select("column_name, data_type, is_nullable")
      .eq("table_name", table.table_name);

    schema[table.table_name] = {
      columns: columns || [],
    };
  }

  schemaCache = schema;
  cacheTime = now;
  return schema;
}

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "supabase://schema",
      name: "Database Schema",
      description: "Full Supabase schema with all tables and columns",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === "supabase://schema") {
    const schema = await getSchema();
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(schema, null, 2),
        },
      ],
    };
  }
  throw new Error("Unknown resource");
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "inspect_schema",
      description:
        "Get full Supabase schema (tables, columns, types). Use to understand database structure.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_table_info",
      description: "Get detailed info about a specific table (columns, types, nullability)",
      inputSchema: {
        type: "object",
        properties: {
          table_name: {
            type: "string",
            description: "Table name (e.g., 'Member', 'Program', 'Pass')",
          },
        },
        required: ["table_name"],
      },
    },
    {
      name: "find_tenant_tables",
      description:
        "Find all tables with tenantId column (multi-tenant scope). Critical for isolation audits.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "raw_query",
      description: "Execute a raw Supabase query for complex introspection",
      inputSchema: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description: "SQL query (read-only, information_schema only)",
          },
        },
        required: ["sql"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "inspect_schema") {
      const schema = await getSchema();
      const summary = Object.entries(schema).map(([tableName, tableInfo]) => ({
        table: tableName,
        columnCount: tableInfo.columns.length,
        columns: tableInfo.columns.map((c) => `${c.column_name}: ${c.data_type}`),
      }));
      return {
        content: [
          {
            type: "text",
            text: `Database Schema (${Object.keys(schema).length} tables):\n\n${JSON.stringify(summary, null, 2)}`,
          },
        ],
      };
    }

    if (name === "get_table_info") {
      const schema = await getSchema();
      const info = schema[args.table_name];
      if (!info) {
        return {
          content: [{ type: "text", text: `Table '${args.table_name}' not found` }],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Table: ${args.table_name}\nColumns:\n${info.columns
              .map((c) => `  - ${c.column_name}: ${c.data_type} (nullable: ${c.is_nullable})`)
              .join("\n")}`,
          },
        ],
      };
    }

    if (name === "find_tenant_tables") {
      const schema = await getSchema();
      const tenantTables = Object.entries(schema)
        .filter(([_, tableInfo]) =>
          tableInfo.columns.some((c) => c.column_name === "tenantId")
        )
        .map(([tableName]) => tableName);

      return {
        content: [
          {
            type: "text",
            text: `Tables with tenantId (${tenantTables.length}):\n${tenantTables.map((t) => `  - ${t}`).join("\n")}\n\n✅ All queries on these tables MUST filter by tenantId explicitly.`,
          },
        ],
      };
    }

    if (name === "raw_query") {
      const { data, error } = await supabase.rpc("sql", { query: args.sql });
      if (error) throw error;
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
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
console.error("Supabase Inspector MCP running");
