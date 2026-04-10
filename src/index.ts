import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Pool } from "pg";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";

// ============================================================================
// PostgreSQL MCP Server v2
//
// Read-only PostgreSQL access with:
//   - Named connections (connections.json) — switch DBs without restarting
//   - Streamable HTTP transport for cloud deployment
//   - stdio transport for local use
//
// Tools: pg_list_connections, pg_use_connection, pg_query, pg_list_tables,
//        pg_describe_table, pg_explain_query, pg_table_stats, pg_list_indexes
// ============================================================================

// ============================================================================
// Named Connections — loaded from connections.json
// ============================================================================

const CONNECTIONS_FILE =
  process.env.CONNECTIONS_FILE ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../connections.json");

type ConnectionsMap = Record<string, string>;

function loadConnections(): ConnectionsMap {
  try {
    const raw = fs.readFileSync(CONNECTIONS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as ConnectionsMap;
    if (Object.keys(parsed).length === 0) {
      throw new Error("connections.json is empty");
    }
    return parsed;
  } catch {
    // Fallback: use DATABASE_URL env variable as a single "default" connection
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      const name = process.env.DEFAULT_DB ?? "default";
      console.error(`[postgres-mcp] connections.json not found — using DATABASE_URL as "${name}"`);
      return { [name]: dbUrl };
    }
    throw new Error(
      `Cannot start: ${CONNECTIONS_FILE} not found and DATABASE_URL not set.\n` +
      `Create connections.json or set DATABASE_URL.`
    );
  }
}

const allConnections: ConnectionsMap = loadConnections();

// ============================================================================
// Pool Management — lazy init, one Pool per named connection
// ============================================================================

const poolCache = new Map<string, Pool>();

function getPool(name: string): Pool {
  if (poolCache.has(name)) return poolCache.get(name)!;

  const connStr = allConnections[name];
  if (!connStr) {
    throw new Error(
      `Connection "${name}" not found. Available: ${Object.keys(allConnections).join(", ")}`
    );
  }

  const pool = new Pool({
    connectionString: connStr,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  poolCache.set(name, pool);
  return pool;
}

// Global active connection state
// Single-user personal tool — global state is appropriate here.
// If you need per-session isolation, wrap this in a session Map.
let activeDbName: string = process.env.DEFAULT_DB ?? Object.keys(allConnections)[0];

function getActivePool(): Pool {
  return getPool(activeDbName);
}

// ============================================================================
// Safety — Read-Only Query Validator
// ============================================================================

const DANGEROUS_KEYWORDS = [
  "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE",
  "CREATE", "GRANT", "REVOKE", "VACUUM", "REINDEX", "CLUSTER", "COPY",
];

function isSafeQuery(sql: string): { safe: boolean; reason?: string } {
  const normalized = sql
    .replace(/--.*$/gm, "")           // strip line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // strip block comments
    .replace(/('([^'\\]|\\.)*')/g, "") // strip string literals
    .toUpperCase()
    .trim();

  for (const kw of DANGEROUS_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`).test(normalized)) {
      return {
        safe: false,
        reason: `Forbidden keyword: ${kw}. Only SELECT/WITH queries are allowed.`,
      };
    }
  }

  if (!normalized.startsWith("SELECT") && !normalized.startsWith("WITH")) {
    return {
      safe: false,
      reason: "Query must start with SELECT or WITH. Only read-only queries are allowed.",
    };
  }

  return { safe: true };
}

// ============================================================================
// Helper — Execute Query with Timeout
// ============================================================================

async function executeQuery(
  sql: string,
  params?: unknown[],
  timeoutMs = 30000
): Promise<{ rows: Record<string, unknown>[]; rowCount: number; fields: string[] }> {
  const client = await getActivePool().connect();
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

// ============================================================================
// Tool Registration — called once per McpServer instance
// ============================================================================

function registerAllTools(server: McpServer): void {

  // --------------------------------------------------------------------------
  // pg_list_connections — list available named connections
  // --------------------------------------------------------------------------
  server.registerTool(
    "pg_list_connections",
    {
      title: "List Database Connections",
      description: `List all available named PostgreSQL connections and show which one is currently active.
Returns names only — credentials are never exposed.
Use pg_use_connection to switch to a different database.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const names = Object.keys(allConnections);
      const lines = [
        "# PostgreSQL Connections",
        "",
        `**Active:** ${activeDbName}`,
        "",
        "| Name | Status |",
        "| --- | --- |",
        ...names.map((n) => `| ${n} | ${n === activeDbName ? "✅ active" : "—"} |`),
        "",
        "Use `pg_use_connection(name)` to switch databases.",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // --------------------------------------------------------------------------
  // pg_use_connection — switch active database
  // --------------------------------------------------------------------------
  server.registerTool(
    "pg_use_connection",
    {
      title: "Switch Active Database Connection",
      description: `Switch the active PostgreSQL connection by name.
All subsequent tool calls will run against the new database.
The switch is verified with a test query — reverts automatically if connection fails.

Args:
  - name: Connection name (from pg_list_connections)`,
      inputSchema: {
        name: z.string().min(1).describe("Connection name to activate"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name }) => {
      if (!allConnections[name]) {
        return {
          content: [{
            type: "text",
            text: `⛔ Connection "${name}" not found.\nAvailable: ${Object.keys(allConnections).join(", ")}`,
          }],
          isError: true,
        };
      }

      const previous = activeDbName;
      activeDbName = name;

      try {
        const result = await executeQuery("SELECT current_database(), version()");
        const row = result.rows[0];
        const shortVersion = String(row.version).split(",")[0]; // e.g. "PostgreSQL 17.4"
        return {
          content: [{
            type: "text",
            text: `✅ Switched: **${previous}** → **${name}**\nDatabase: ${row.current_database}\nServer: ${shortVersion}`,
          }],
        };
      } catch (error) {
        activeDbName = previous; // revert
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: "text",
            text: `⛔ Cannot connect to "${name}": ${msg}\nReverted to "${previous}".`,
          }],
          isError: true,
        };
      }
    }
  );

  // --------------------------------------------------------------------------
  // pg_query — execute read-only SQL
  // --------------------------------------------------------------------------
  server.registerTool(
    "pg_query",
    {
      title: "Query PostgreSQL Database",
      description: `Execute a read-only SQL query against the active database.
Only SELECT and WITH (CTE) statements are allowed — writes are blocked.

Args:
  - sql: SELECT or WITH query (max 10 000 chars)
  - limit: Max rows to return (default 100, max 1000)

Tip: use pg_use_connection first to switch databases.`,
      inputSchema: {
        sql: z
          .string()
          .min(1, "SQL cannot be empty")
          .max(10000, "SQL too long")
          .describe("SQL SELECT/WITH query"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(100)
          .describe("Max rows to return (default 100)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ sql, limit }) => {
      const safety = isSafeQuery(sql);
      if (!safety.safe) {
        return {
          content: [{ type: "text", text: `⛔ Blocked: ${safety.reason}` }],
          isError: true,
        };
      }

      const finalSql = sql.toUpperCase().includes("LIMIT") ? sql : `${sql} LIMIT ${limit}`;

      try {
        const result = await executeQuery(finalSql);

        if (result.rows.length === 0) {
          return {
            content: [{ type: "text", text: `Query returned 0 rows. [db: ${activeDbName}]` }],
          };
        }

        const headers = result.fields;
        const table = [
          `**${result.rowCount} rows** from \`${activeDbName}\` (${headers.length} columns)`,
          "",
          `| ${headers.join(" | ")} |`,
          `| ${headers.map(() => "---").join(" | ")} |`,
          ...result.rows.map(
            (row) =>
              `| ${headers
                .map((h) => {
                  const v = row[h];
                  if (v === null) return "NULL";
                  if (typeof v === "object") return JSON.stringify(v);
                  return String(v);
                })
                .join(" | ")} |`
          ),
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

  // --------------------------------------------------------------------------
  // pg_list_tables — list tables with sizes and row counts
  // --------------------------------------------------------------------------
  server.registerTool(
    "pg_list_tables",
    {
      title: "List Database Tables",
      description: `List all tables in the active database with estimated row counts and disk sizes.

Args:
  - schema: Schema name (default: public)`,
      inputSchema: {
        schema: z.string().default("public").describe("Schema name (default: public)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ schema }) => {
      try {
        const result = await executeQuery(
          `SELECT
            t.tablename AS table_name,
            pg_size_pretty(pg_total_relation_size(
              quote_ident(t.schemaname) || '.' || quote_ident(t.tablename)
            )) AS total_size,
            COALESCE(s.n_live_tup, 0) AS estimated_rows,
            obj_description((
              quote_ident(t.schemaname) || '.' || quote_ident(t.tablename)
            )::regclass) AS comment
          FROM pg_tables t
          LEFT JOIN pg_stat_user_tables s
            ON t.schemaname = s.schemaname AND t.tablename = s.relname
          WHERE t.schemaname = $1
          ORDER BY COALESCE(s.n_live_tup, 0) DESC`,
          [schema]
        );

        if (result.rows.length === 0) {
          return {
            content: [{ type: "text", text: `No tables in schema '${schema}'. [db: ${activeDbName}]` }],
          };
        }

        const lines = [
          `# Tables in \`${activeDbName}\` / schema \`${schema}\``,
          "",
          `${result.rows.length} table(s):`,
          "",
          "| Table | Rows (est.) | Total Size | Comment |",
          "| --- | --- | --- | --- |",
          ...result.rows.map(
            (r) =>
              `| ${r.table_name} | ${Number(r.estimated_rows).toLocaleString()} | ${r.total_size} | ${r.comment ?? "—"} |`
          ),
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // --------------------------------------------------------------------------
  // pg_describe_table — columns, types, constraints, indexes
  // --------------------------------------------------------------------------
  server.registerTool(
    "pg_describe_table",
    {
      title: "Describe Table Structure",
      description: `Show the full structure of a table: columns, data types, nullability, defaults,
primary key, foreign keys, and indexes.

Args:
  - table: Table name
  - schema: Schema name (default: public)`,
      inputSchema: {
        table: z.string().min(1).describe("Table name"),
        schema: z.string().default("public").describe("Schema name (default: public)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ table, schema }) => {
      try {
        const columns = await executeQuery(
          `SELECT
            c.column_name, c.data_type, c.character_maximum_length,
            c.is_nullable, c.column_default,
            col_description(
              (quote_ident($2) || '.' || quote_ident($1))::regclass,
              c.ordinal_position
            ) AS comment
          FROM information_schema.columns c
          WHERE c.table_schema = $2 AND c.table_name = $1
          ORDER BY c.ordinal_position`,
          [table, schema]
        );

        if (columns.rows.length === 0) {
          return {
            content: [{ type: "text", text: `Table '${schema}.${table}' not found in '${activeDbName}'.` }],
            isError: true,
          };
        }

        const pk = await executeQuery(
          `SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          WHERE tc.table_schema = $2 AND tc.table_name = $1
            AND tc.constraint_type = 'PRIMARY KEY'
          ORDER BY kcu.ordinal_position`,
          [table, schema]
        );

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
          WHERE tc.table_schema = $2 AND tc.table_name = $1
            AND tc.constraint_type = 'FOREIGN KEY'`,
          [table, schema]
        );

        const indexes = await executeQuery(
          `SELECT indexname, indexdef
          FROM pg_indexes
          WHERE schemaname = $2 AND tablename = $1`,
          [table, schema]
        );

        const pkCols = new Set(pk.rows.map((r) => r.column_name));
        const fkMap = new Map(
          fks.rows.map((r) => [
            r.column_name as string,
            `→ ${r.ref_schema}.${r.ref_table}.${r.ref_column}`,
          ])
        );

        const lines = [`# Table: ${schema}.${table} [${activeDbName}]`, ""];
        lines.push("## Columns", "");
        lines.push("| Column | Type | Nullable | Default | PK | FK | Comment |");
        lines.push("| --- | --- | --- | --- | --- | --- | --- |");

        for (const col of columns.rows) {
          const typeName = col.character_maximum_length
            ? `${col.data_type}(${col.character_maximum_length})`
            : String(col.data_type);

          lines.push(
            `| ${col.column_name} | ${typeName} | ${col.is_nullable} | ${col.column_default ?? "—"} | ${pkCols.has(col.column_name as string) ? "✅" : ""} | ${fkMap.get(col.column_name as string) ?? ""} | ${col.comment ?? ""} |`
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
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // --------------------------------------------------------------------------
  // pg_explain_query — EXPLAIN ANALYZE
  // --------------------------------------------------------------------------
  server.registerTool(
    "pg_explain_query",
    {
      title: "Explain Query Plan",
      description: `Run EXPLAIN ANALYZE on a SELECT query to show the execution plan with actual timings.
Useful for understanding and optimizing query performance.

Args:
  - sql: SQL SELECT query to analyze`,
      inputSchema: {
        sql: z.string().min(1).max(10000).describe("SQL SELECT query to explain"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
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
        const result = await executeQuery(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`);
        const plan = result.rows.map((r) => Object.values(r)[0]).join("\n");
        return {
          content: [{
            type: "text",
            text: `# Query Plan [${activeDbName}]\n\n\`\`\`\n${plan}\n\`\`\`\n\n**Query:**\n\`\`\`sql\n${sql}\n\`\`\``,
          }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Explain error: ${msg}` }], isError: true };
      }
    }
  );

  // --------------------------------------------------------------------------
  // pg_table_stats — vacuum, row counts, scan usage
  // --------------------------------------------------------------------------
  server.registerTool(
    "pg_table_stats",
    {
      title: "Table Statistics",
      description: `Show detailed statistics for a table: sizes, live/dead rows, insert/update/delete counts,
sequential vs index scan usage, and vacuum/analyze timestamps.

Args:
  - table: Table name
  - schema: Schema name (default: public)`,
      inputSchema: {
        table: z.string().min(1).describe("Table name"),
        schema: z.string().default("public").describe("Schema name"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ table, schema }) => {
      try {
        const result = await executeQuery(
          `SELECT
            n_live_tup AS live_rows, n_dead_tup AS dead_rows,
            n_tup_ins AS total_inserts, n_tup_upd AS total_updates, n_tup_del AS total_deletes,
            seq_scan, seq_tup_read, idx_scan, idx_tup_fetch,
            last_vacuum, last_autovacuum, last_analyze, last_autoanalyze,
            pg_size_pretty(pg_total_relation_size(
              quote_ident($2) || '.' || quote_ident($1)
            )) AS total_size,
            pg_size_pretty(pg_relation_size(
              quote_ident($2) || '.' || quote_ident($1)
            )) AS table_size,
            pg_size_pretty(pg_indexes_size(
              (quote_ident($2) || '.' || quote_ident($1))::regclass
            )) AS indexes_size
          FROM pg_stat_user_tables
          WHERE schemaname = $2 AND relname = $1`,
          [table, schema]
        );

        if (result.rows.length === 0) {
          return {
            content: [{ type: "text", text: `Table '${schema}.${table}' not found in stats. [db: ${activeDbName}]` }],
            isError: true,
          };
        }

        const s = result.rows[0];
        const lines = [
          `# Stats: ${schema}.${table} [${activeDbName}]`,
          "",
          "## Size",
          `- **Total:** ${s.total_size} | **Table:** ${s.table_size} | **Indexes:** ${s.indexes_size}`,
          "",
          "## Row Activity",
          `- **Live rows:** ${Number(s.live_rows).toLocaleString()} | **Dead rows:** ${Number(s.dead_rows).toLocaleString()}`,
          `- **Inserts:** ${Number(s.total_inserts).toLocaleString()} | **Updates:** ${Number(s.total_updates).toLocaleString()} | **Deletes:** ${Number(s.total_deletes).toLocaleString()}`,
          "",
          "## Scan Usage",
          `- **Seq scans:** ${Number(s.seq_scan).toLocaleString()} (read ${Number(s.seq_tup_read).toLocaleString()} rows)`,
          `- **Index scans:** ${Number(s.idx_scan).toLocaleString()} (fetched ${Number(s.idx_tup_fetch).toLocaleString()} rows)`,
          "",
          "## Maintenance",
          `- **Last vacuum:** ${s.last_vacuum ?? "never"} | **Last autovacuum:** ${s.last_autovacuum ?? "never"}`,
          `- **Last analyze:** ${s.last_analyze ?? "never"} | **Last autoanalyze:** ${s.last_autoanalyze ?? "never"}`,
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // --------------------------------------------------------------------------
  // pg_list_indexes — index definitions, sizes, usage stats
  // --------------------------------------------------------------------------
  server.registerTool(
    "pg_list_indexes",
    {
      title: "List Table Indexes",
      description: `List all indexes on a table with their definitions, disk sizes, and usage statistics (scan counts).

Args:
  - table: Table name
  - schema: Schema name (default: public)`,
      inputSchema: {
        table: z.string().min(1).describe("Table name"),
        schema: z.string().default("public").describe("Schema name"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ table, schema }) => {
      try {
        const result = await executeQuery(
          `SELECT
            i.indexname, i.indexdef,
            pg_size_pretty(pg_relation_size(
              quote_ident(i.schemaname) || '.' || quote_ident(i.indexname)
            )) AS index_size,
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
            content: [{ type: "text", text: `No indexes on '${schema}.${table}'. [db: ${activeDbName}]` }],
          };
        }

        const lines = [
          `# Indexes: ${schema}.${table} [${activeDbName}]`,
          "",
          `${result.rows.length} index(es):`,
          "",
        ];

        for (const idx of result.rows) {
          lines.push(`### ${idx.indexname}`);
          lines.push(`- **Size:** ${idx.index_size} | **Scans:** ${Number(idx.scan_count).toLocaleString()} | **Tuples read:** ${Number(idx.tuples_read).toLocaleString()}`);
          lines.push(`- **Def:** \`${idx.indexdef}\``);
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}

// ============================================================================
// HTTP body parser helper
// ============================================================================

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ============================================================================
// Main — stdio or HTTP transport based on TRANSPORT env var
// ============================================================================

async function main(): Promise<void> {
  const transport_mode = process.env.TRANSPORT ?? "stdio";

  if (transport_mode === "http") {
    // -------------------------------------------------------------------------
    // HTTP mode — dual transport for maximum compatibility:
    //   /sse      — SSE transport  (Cowork, older Claude Code)
    //   /messages — SSE POST handler
    //   /mcp      — Streamable HTTP (Claude Code CLI, modern clients)
    //   /health   — health check (no auth)
    //
    // Auth: ?token=xxx  OR  Authorization: Bearer xxx
    // -------------------------------------------------------------------------
    const PORT = parseInt(process.env.PORT ?? "3200");
    const MCP_TOKEN = process.env.MCP_TOKEN;

    // SSE sessions: sessionId → SSEServerTransport
    const sseSessions = new Map<string, SSEServerTransport>();
    // Streamable HTTP sessions: mcp-session-id → StreamableHTTPServerTransport
    const httpSessions = new Map<string, StreamableHTTPServerTransport>();

    // -- Auth helper --
    function checkToken(reqUrl: URL, req: IncomingMessage, res: ServerResponse): boolean {
      if (!MCP_TOKEN) return true;
      const queryToken = reqUrl.searchParams.get("token") ?? "";
      const bearerToken = (req.headers["authorization"] ?? "")
        .replace(/^Bearer\s+/i, "").trim();
      if ((queryToken || bearerToken) === MCP_TOKEN) return true;
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return false;
    }

    const httpServer = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? "/", `http://localhost`);

      // ── Health check (no auth) ──────────────────────────────────────────────
      if (reqUrl.pathname === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          activeDb: activeDbName,
          connections: Object.keys(allConnections),
          sseSessions: sseSessions.size,
          httpSessions: httpSessions.size,
        }));
        return;
      }

      // /messages не требует токена — sessionId сам по себе авторизует
      const isMessagesEndpoint = reqUrl.pathname === "/messages";
      if (!isMessagesEndpoint && !checkToken(reqUrl, req, res)) return;

      // ── SSE transport: GET /sse ─────────────────────────────────────────────
      // Used by Cowork and older Claude Code versions
      if (reqUrl.pathname === "/sse" && req.method === "GET") {
        const transport = new SSEServerTransport("/messages", res);
        sseSessions.set(transport.sessionId, transport);

        res.on("close", () => {
          sseSessions.delete(transport.sessionId);
          console.error(`[postgres-mcp] SSE session closed: ${transport.sessionId}`);
        });

        const mcpServer = new McpServer({ name: "postgres-mcp-server", version: "2.0.0" });
        registerAllTools(mcpServer);
        await mcpServer.connect(transport);
        console.error(`[postgres-mcp] SSE session opened: ${transport.sessionId} | db: ${activeDbName}`);
        return;
      }

      // ── SSE transport: POST /messages ───────────────────────────────────────
      if (reqUrl.pathname === "/messages" && req.method === "POST") {
        const sessionId = reqUrl.searchParams.get("sessionId") ?? "";
        const transport = sseSessions.get(sessionId);
        if (!transport) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "SSE session not found" }));
          return;
        }
        let parsedBody: unknown;
        try { parsedBody = await parseBody(req); } catch {
          res.writeHead(400); res.end("Invalid JSON"); return;
        }
        await transport.handlePostMessage(req, res, parsedBody);
        return;
      }

      // ── Streamable HTTP transport: /mcp ─────────────────────────────────────
      // Used by Claude Code CLI with --transport http
      if (reqUrl.pathname === "/mcp") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && httpSessions.has(sessionId)) {
          transport = httpSessions.get(sessionId)!;

        } else if (!sessionId && req.method === "POST") {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) httpSessions.delete(sid);
          };
          const mcpServer = new McpServer({ name: "postgres-mcp-server", version: "2.0.0" });
          registerAllTools(mcpServer);
          await mcpServer.connect(transport);
          const sid = transport.sessionId;
          if (sid) httpSessions.set(sid, transport);
          console.error(`[postgres-mcp] HTTP session opened: ${sid} | db: ${activeDbName}`);

        } else if (sessionId && !httpSessions.has(sessionId)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found. Please reinitialize." }));
          return;

        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Bad Request" }));
          return;
        }

        let parsedBody: unknown;
        if (req.method === "POST") {
          try { parsedBody = await parseBody(req); } catch {
            res.writeHead(400); res.end("Invalid JSON"); return;
          }
        }
        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    httpServer.listen(PORT, "0.0.0.0", () => {
      console.error(`[postgres-mcp] Running on port ${PORT}`);
      console.error(`[postgres-mcp] SSE endpoint:  http://0.0.0.0:${PORT}/sse   ← Cowork`);
      console.error(`[postgres-mcp] HTTP endpoint: http://0.0.0.0:${PORT}/mcp   ← Claude Code CLI`);
      console.error(`[postgres-mcp] Health:        http://0.0.0.0:${PORT}/health`);
      console.error(`[postgres-mcp] Active DB: ${activeDbName} | Auth: ${MCP_TOKEN ? "enabled" : "DISABLED"}`);
    });

  } else {
    // -------------------------------------------------------------------------
    // stdio mode — local use with Claude Code / Claude Desktop
    // -------------------------------------------------------------------------
    const mcpServer = new McpServer({
      name: "postgres-mcp-server",
      version: "2.0.0",
    });
    registerAllTools(mcpServer);
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error(`[postgres-mcp] Running on stdio | Active DB: ${activeDbName}`);
  }
}

main().catch((error) => {
  console.error("[postgres-mcp] Fatal error:", error);
  process.exit(1);
});

// Graceful shutdown — close all connection pools
async function shutdown() {
  console.error("[postgres-mcp] Shutting down...");
  for (const pool of poolCache.values()) {
    await pool.end().catch(() => {});
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
