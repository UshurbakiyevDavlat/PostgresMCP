import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Pool, type PoolConfig } from "pg";
import { z } from "zod";

// ============================================================================
// PostgreSQL MCP Server
// Provides Claude with read-only access to a PostgreSQL database.
// Tools: pg_query, pg_list_tables, pg_describe_table, pg_explain_query,
//        pg_table_stats, pg_list_indexes
// ============================================================================

// --- Database Connection ---

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is required");
  console.error("Example: DATABASE_URL=postgres://user:pass@localhost:5432/mydb");
  process.exit(1);
}

const poolConfig: PoolConfig = {
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

const pool = new Pool(poolConfig);

// --- Safety: Read-Only Query Validator ---

const DANGEROUS_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "CREATE",
  "GRANT",
  "REVOKE",
  "VACUUM",
  "REINDEX",
  "CLUSTER",
  "COPY",
];

function isSafeQuery(sql: string): { safe: boolean; reason?: string } {
  const normalized = sql
    .replace(/--.*$/gm, "") // Remove single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // Remove block comments
    .replace(/('([^'\\]|\\.)*')/g, "") // Remove string literals
    .toUpperCase()
    .trim();

  for (const keyword of DANGEROUS_KEYWORDS) {
    // Match keyword at word boundary to avoid false positives
    const regex = new RegExp(`\\b${keyword}\\b`);
    if (regex.test(normalized)) {
      return {
        safe: false,
        reason: `Query contains forbidden keyword: ${keyword}. Only SELECT/WITH queries are allowed.`,
      };
    }
  }

  // Must start with SELECT or WITH (CTE)
  if (!normalized.startsWith("SELECT") && !normalized.startsWith("WITH")) {
    return {
      safe: false,
      reason:
        "Query must start with SELECT or WITH. Only read-only queries are allowed.",
    };
  }

  return { safe: true };
}

// --- Helper: Execute Query with Timeout ---

async function executeQuery(
  sql: string,
  params?: unknown[],
  timeoutMs: number = 30000
): Promise<{ rows: Record<string, unknown>[]; rowCount: number; fields: string[] }> {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${timeoutMs}`);
    const result = await client.query(sql, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
      fields: result.fields.map((f) => f.name),
    };
  } finally {
    client.release();
  }
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "postgres-mcp-server",
  version: "1.0.0",
});

// ============================================================================
// Tool 1: pg_query — Execute read-only SQL queries
// ============================================================================

server.registerTool(
  "pg_query",
  {
    title: "Query PostgreSQL Database",
    description: `Execute a read-only SQL query against the PostgreSQL database.

ONLY SELECT and WITH (CTE) queries are allowed. INSERT, UPDATE, DELETE, DROP,
ALTER, and other write operations are blocked for safety.

Args:
  - sql (string): The SQL query to execute. Must be a SELECT or WITH statement.
  - limit (number): Maximum rows to return (default: 100, max: 1000).

Returns:
  Query results as a table with column names and row data.

Examples:
  - "SELECT * FROM users WHERE created_at > '2024-01-01' LIMIT 10"
  - "WITH active AS (SELECT * FROM users WHERE active = true) SELECT count(*) FROM active"

Error Handling:
  - Returns error if query contains write operations
  - Returns error if query times out (30s limit)
  - Returns error if syntax is invalid`,
    inputSchema: {
      sql: z
        .string()
        .min(1, "SQL query cannot be empty")
        .max(10000, "SQL query too long (max 10000 chars)")
        .describe("SQL SELECT query to execute"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Maximum rows to return (default: 100)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ sql, limit }) => {
    // Safety check
    const safety = isSafeQuery(sql);
    if (!safety.safe) {
      return {
        content: [{ type: "text", text: `⛔ Blocked: ${safety.reason}` }],
        isError: true,
      };
    }

    // Add LIMIT if not present
    const normalizedSql = sql.toUpperCase();
    const finalSql =
      normalizedSql.includes("LIMIT") ? sql : `${sql} LIMIT ${limit}`;

    try {
      const result = await executeQuery(finalSql);

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text", text: "Query returned 0 rows." }],
        };
      }

      // Format as markdown table
      const headers = result.fields;
      const headerLine = `| ${headers.join(" | ")} |`;
      const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
      const dataLines = result.rows.map(
        (row) =>
          `| ${headers.map((h) => {
            const val = row[h];
            if (val === null) return "NULL";
            if (typeof val === "object") return JSON.stringify(val);
            return String(val);
          }).join(" | ")} |`
      );

      const table = [
        `**${result.rowCount} rows returned** (fields: ${headers.length})`,
        "",
        headerLine,
        separatorLine,
        ...dataLines,
      ].join("\n");

      return { content: [{ type: "text", text: table }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Query error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ============================================================================
// Tool 2: pg_list_tables — List all tables with row counts
// ============================================================================

server.registerTool(
  "pg_list_tables",
  {
    title: "List Database Tables",
    description: `List all tables in the database with their schemas, row counts, and sizes.

Args:
  - schema (string): Schema to list tables from (default: 'public')

Returns:
  Table listing with name, estimated row count, and disk size.`,
    inputSchema: {
      schema: z
        .string()
        .default("public")
        .describe("Schema name (default: public)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ schema }) => {
    try {
      const result = await executeQuery(
        `SELECT
          t.tablename AS table_name,
          pg_size_pretty(pg_total_relation_size(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))) AS total_size,
          COALESCE(s.n_live_tup, 0) AS estimated_rows,
          obj_description((quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))::regclass) AS comment
        FROM pg_tables t
        LEFT JOIN pg_stat_user_tables s
          ON t.schemaname = s.schemaname AND t.tablename = s.relname
        WHERE t.schemaname = $1
        ORDER BY COALESCE(s.n_live_tup, 0) DESC`,
        [schema]
      );

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text", text: `No tables found in schema '${schema}'.` }],
        };
      }

      const lines = [`# Tables in schema '${schema}'`, "", `Found ${result.rows.length} tables:`, ""];
      lines.push("| Table | Rows (est.) | Size | Comment |");
      lines.push("| --- | --- | --- | --- |");

      for (const row of result.rows) {
        lines.push(
          `| ${row.table_name} | ${Number(row.estimated_rows).toLocaleString()} | ${row.total_size} | ${row.comment || "—"} |`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error listing tables: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ============================================================================
// Tool 3: pg_describe_table — Show table structure
// ============================================================================

server.registerTool(
  "pg_describe_table",
  {
    title: "Describe Table Structure",
    description: `Show the full structure of a table: columns, types, constraints, defaults, and foreign keys.

Args:
  - table (string): Table name to describe
  - schema (string): Schema name (default: 'public')

Returns:
  Detailed table structure with column definitions, primary keys, foreign keys, and indexes.`,
    inputSchema: {
      table: z.string().min(1).describe("Table name to describe"),
      schema: z
        .string()
        .default("public")
        .describe("Schema name (default: public)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ table, schema }) => {
    try {
      // Columns
      const columns = await executeQuery(
        `SELECT
          c.column_name,
          c.data_type,
          c.character_maximum_length,
          c.is_nullable,
          c.column_default,
          col_description((quote_ident($2) || '.' || quote_ident($1))::regclass, c.ordinal_position) AS comment
        FROM information_schema.columns c
        WHERE c.table_schema = $2 AND c.table_name = $1
        ORDER BY c.ordinal_position`,
        [table, schema]
      );

      if (columns.rows.length === 0) {
        return {
          content: [{ type: "text", text: `Table '${schema}.${table}' not found.` }],
          isError: true,
        };
      }

      // Primary key
      const pk = await executeQuery(
        `SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_schema = $2 AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position`,
        [table, schema]
      );

      // Foreign keys
      const fks = await executeQuery(
        `SELECT
          kcu.column_name,
          ccu.table_schema AS ref_schema,
          ccu.table_name AS ref_table,
          ccu.column_name AS ref_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.table_schema = $2 AND tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'`,
        [table, schema]
      );

      // Indexes
      const indexes = await executeQuery(
        `SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = $2 AND tablename = $1`,
        [table, schema]
      );

      // Format output
      const pkCols = new Set(pk.rows.map((r) => r.column_name));
      const fkMap = new Map(
        fks.rows.map((r) => [
          r.column_name as string,
          `→ ${r.ref_schema}.${r.ref_table}.${r.ref_column}`,
        ])
      );

      const lines = [`# Table: ${schema}.${table}`, ""];
      lines.push("## Columns", "");
      lines.push("| Column | Type | Nullable | Default | PK | FK | Comment |");
      lines.push("| --- | --- | --- | --- | --- | --- | --- |");

      for (const col of columns.rows) {
        const typeName = col.character_maximum_length
          ? `${col.data_type}(${col.character_maximum_length})`
          : String(col.data_type);

        lines.push(
          `| ${col.column_name} | ${typeName} | ${col.is_nullable} | ${col.column_default || "—"} | ${pkCols.has(col.column_name as string) ? "✅" : ""} | ${fkMap.get(col.column_name as string) || ""} | ${col.comment || ""} |`
        );
      }

      if (indexes.rows.length > 0) {
        lines.push("", "## Indexes", "");
        for (const idx of indexes.rows) {
          lines.push(`- **${idx.indexname}**: \`${idx.indexdef}\``);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error describing table: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ============================================================================
// Tool 4: pg_explain_query — Show query execution plan
// ============================================================================

server.registerTool(
  "pg_explain_query",
  {
    title: "Explain Query Plan",
    description: `Show the execution plan for a SQL query using EXPLAIN ANALYZE.
Useful for understanding query performance and optimization.

Args:
  - sql (string): The SQL SELECT query to explain

Returns:
  The query execution plan with timing and cost estimates.`,
    inputSchema: {
      sql: z
        .string()
        .min(1)
        .max(10000)
        .describe("SQL SELECT query to explain"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false, // ANALYZE actually executes
      openWorldHint: false,
    },
  },
  async ({ sql }) => {
    const safety = isSafeQuery(sql);
    if (!safety.safe) {
      return {
        content: [{ type: "text", text: `⛔ Blocked: ${safety.reason}` }],
        isError: true,
      };
    }

    try {
      const result = await executeQuery(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`
      );

      const plan = result.rows
        .map((r) => Object.values(r)[0])
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `# Query Plan\n\n\`\`\`\n${plan}\n\`\`\`\n\n**Original query:**\n\`\`\`sql\n${sql}\n\`\`\``,
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Explain error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ============================================================================
// Tool 5: pg_table_stats — Show table statistics
// ============================================================================

server.registerTool(
  "pg_table_stats",
  {
    title: "Table Statistics",
    description: `Show detailed statistics for a table: row count, dead tuples, last vacuum/analyze times, and sequential vs index scan usage.

Args:
  - table (string): Table name
  - schema (string): Schema name (default: 'public')

Returns:
  Table health statistics useful for performance analysis.`,
    inputSchema: {
      table: z.string().min(1).describe("Table name"),
      schema: z.string().default("public").describe("Schema name"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ table, schema }) => {
    try {
      const result = await executeQuery(
        `SELECT
          n_live_tup AS live_rows,
          n_dead_tup AS dead_rows,
          n_tup_ins AS total_inserts,
          n_tup_upd AS total_updates,
          n_tup_del AS total_deletes,
          seq_scan,
          seq_tup_read,
          idx_scan,
          idx_tup_fetch,
          last_vacuum,
          last_autovacuum,
          last_analyze,
          last_autoanalyze,
          pg_size_pretty(pg_total_relation_size(quote_ident($2) || '.' || quote_ident($1))) AS total_size,
          pg_size_pretty(pg_relation_size(quote_ident($2) || '.' || quote_ident($1))) AS table_size,
          pg_size_pretty(pg_indexes_size((quote_ident($2) || '.' || quote_ident($1))::regclass)) AS indexes_size
        FROM pg_stat_user_tables
        WHERE schemaname = $2 AND relname = $1`,
        [table, schema]
      );

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text", text: `Table '${schema}.${table}' not found in statistics.` }],
          isError: true,
        };
      }

      const s = result.rows[0];
      const lines = [
        `# Statistics: ${schema}.${table}`,
        "",
        "## Size",
        `- **Total size:** ${s.total_size}`,
        `- **Table data:** ${s.table_size}`,
        `- **Indexes:** ${s.indexes_size}`,
        "",
        "## Row Activity",
        `- **Live rows:** ${Number(s.live_rows).toLocaleString()}`,
        `- **Dead rows:** ${Number(s.dead_rows).toLocaleString()}`,
        `- **Total inserts:** ${Number(s.total_inserts).toLocaleString()}`,
        `- **Total updates:** ${Number(s.total_updates).toLocaleString()}`,
        `- **Total deletes:** ${Number(s.total_deletes).toLocaleString()}`,
        "",
        "## Scan Usage",
        `- **Sequential scans:** ${Number(s.seq_scan).toLocaleString()} (read ${Number(s.seq_tup_read).toLocaleString()} rows)`,
        `- **Index scans:** ${Number(s.idx_scan).toLocaleString()} (fetched ${Number(s.idx_tup_fetch).toLocaleString()} rows)`,
        "",
        "## Maintenance",
        `- **Last vacuum:** ${s.last_vacuum || "never"}`,
        `- **Last autovacuum:** ${s.last_autovacuum || "never"}`,
        `- **Last analyze:** ${s.last_analyze || "never"}`,
        `- **Last autoanalyze:** ${s.last_autoanalyze || "never"}`,
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ============================================================================
// Tool 6: pg_list_indexes — List all indexes for a table
// ============================================================================

server.registerTool(
  "pg_list_indexes",
  {
    title: "List Table Indexes",
    description: `List all indexes on a table with their definitions, sizes, and usage statistics.

Args:
  - table (string): Table name
  - schema (string): Schema name (default: 'public')

Returns:
  Index listing with definitions, sizes, and scan counts.`,
    inputSchema: {
      table: z.string().min(1).describe("Table name"),
      schema: z.string().default("public").describe("Schema name"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ table, schema }) => {
    try {
      const result = await executeQuery(
        `SELECT
          i.indexname,
          i.indexdef,
          pg_size_pretty(pg_relation_size(quote_ident(i.schemaname) || '.' || quote_ident(i.indexname))) AS index_size,
          COALESCE(s.idx_scan, 0) AS scan_count,
          COALESCE(s.idx_tup_read, 0) AS tuples_read,
          COALESCE(s.idx_tup_fetch, 0) AS tuples_fetched
        FROM pg_indexes i
        LEFT JOIN pg_stat_user_indexes s
          ON i.schemaname = s.schemaname AND i.indexname = s.indexrelname
        WHERE i.schemaname = $2 AND i.tablename = $1
        ORDER BY COALESCE(s.idx_scan, 0) DESC`,
        [table, schema]
      );

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text", text: `No indexes found for '${schema}.${table}'.` }],
        };
      }

      const lines = [
        `# Indexes on ${schema}.${table}`,
        "",
        `Found ${result.rows.length} indexes:`,
        "",
      ];

      for (const idx of result.rows) {
        lines.push(`### ${idx.indexname}`);
        lines.push(`- **Size:** ${idx.index_size}`);
        lines.push(`- **Scans:** ${Number(idx.scan_count).toLocaleString()}`);
        lines.push(`- **Tuples read:** ${Number(idx.tuples_read).toLocaleString()}`);
        lines.push(`- **Definition:** \`${idx.indexdef}\``);
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ============================================================================
// Start Server
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("PostgreSQL MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
