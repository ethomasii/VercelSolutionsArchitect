// Snowflake integration — ACCOUNT_USAGE for warehouse contention, query history.
//
// Uses the official snowflake-sdk Node.js driver (not the REST SQL API).
// Runs in Vercel Serverless Functions (Node.js runtime) — NOT Edge runtime.
// Mark any route that calls this with: export const runtime = 'nodejs'
//
// SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY is the gold mine for diagnosing:
// - Which queries ran concurrently with the failing job
// - Warehouse credit consumption (who's hogging the warehouse)
// - Query execution time anomalies
//
// Note: ACCOUNT_USAGE has a ~45min lag. For real-time use INFORMATION_SCHEMA.QUERY_HISTORY
// (only shows your own queries, no lag — swap the FROM clause to switch).

import snowflake from 'snowflake-sdk';
import { getSetting } from '../settings';
import { getSyntheticSnowflakeContention } from '../demo-data';

// Silence the verbose SDK logger in production
snowflake.configure({ logLevel: 'ERROR' });

export interface WarehouseContention {
  warehouse: string;
  timeWindowMinutes: number;
  concurrentQueries: Array<{
    queryId: string;
    user: string;
    warehouseName: string;
    status: string;
    startTime: string;
    durationSeconds: number;
    creditsUsed: number;
    queryText: string;
  }>;
  hasContention: boolean;
  contentionNote: string;
  source: 'live' | 'synthetic' | 'unavailable';
}

async function getSnowflakeCredentials(): Promise<{
  account: string; username: string; password: string; warehouse: string;
  database?: string; schema?: string;
} | null> {
  const account = await getSetting('snowflake', 'SNOWFLAKE_ACCOUNT');
  const username = await getSetting('snowflake', 'SNOWFLAKE_USER');
  const password = await getSetting('snowflake', 'SNOWFLAKE_PASSWORD');
  const warehouse = await getSetting('snowflake', 'SNOWFLAKE_WAREHOUSE');
  if (!account || !username || !password) return null;
  return {
    account,
    username,
    password,
    warehouse: warehouse ?? 'COMPUTE_WH',
    database: 'SNOWFLAKE',
    schema: 'ACCOUNT_USAGE',
  };
}

// Execute a single SQL query and return rows as plain objects.
// Creates a connection, runs the query, destroys the connection.
// For higher-throughput use, extract connection pooling to a module-level singleton.
function executeQuery(creds: NonNullable<Awaited<ReturnType<typeof getSnowflakeCredentials>>>, sql: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection({
      account: creds.account,
      username: creds.username,
      password: creds.password,
      warehouse: creds.warehouse,
      database: creds.database,
      schema: creds.schema,
      // Keep connections short-lived in serverless — no keep-alive
      application: 'dispatch-triage',
    });

    conn.connect((err) => {
      if (err) { reject(new Error(`Snowflake connect failed: ${err.message}`)); return; }

      conn.execute({
        sqlText: sql,
        complete: (err, _stmt, rows) => {
          conn.destroy(() => {}); // always close, ignore destroy errors
          if (err) { reject(new Error(`Snowflake query failed: ${err.message}`)); return; }
          resolve((rows ?? []) as Record<string, unknown>[]);
        },
      });
    });
  });
}

// Query SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY for warehouse contention
// around the time of a failure.
export async function getWarehouseContention(
  warehouseName: string,
  failureTimeUtc: string,
  windowMinutes = 120
): Promise<WarehouseContention> {
  const creds = await getSnowflakeCredentials();

  if (!creds) {
    // Fall through to synthetic data for demo
    const synthetic = getSyntheticSnowflakeContention(warehouseName, failureTimeUtc);
    if (synthetic.length > 0) {
      const heavyJobs = synthetic.filter(q => q.creditsUsed > 10);
      return {
        warehouse: warehouseName,
        timeWindowMinutes: windowMinutes,
        concurrentQueries: synthetic.map(q => ({
          queryId: q.queryId,
          user: q.user,
          warehouseName: q.warehouseName,
          status: q.creditsUsed === 0 ? 'TIMED_OUT' : 'SUCCEEDED',
          startTime: q.startTime,
          durationSeconds: q.durationSeconds,
          creditsUsed: q.creditsUsed,
          queryText: q.queryText,
        })),
        hasContention: heavyJobs.length > 0,
        contentionNote: heavyJobs.length > 0
          ? `⚠️ Warehouse contention detected (synthetic demo). ${heavyJobs[0].user} consumed ${heavyJobs[0].creditsUsed} credits — add SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PASSWORD in /settings for live data`
          : 'No contention in demo data',
        source: 'synthetic',
      };
    }
    return {
      warehouse: warehouseName,
      timeWindowMinutes: windowMinutes,
      concurrentQueries: [],
      hasContention: false,
      contentionNote: 'Snowflake credentials not configured — add SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PASSWORD in /settings',
      source: 'unavailable',
    };
  }

  // Live query via snowflake-sdk driver
  // ACCOUNT_USAGE has ~45min lag — for freshness alerts swap to INFORMATION_SCHEMA.QUERY_HISTORY
  try {
    const sql = `
      SELECT
        QUERY_ID,
        USER_NAME,
        WAREHOUSE_NAME,
        EXECUTION_STATUS,
        TO_CHAR(START_TIME, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS START_TIME,
        ROUND(TOTAL_ELAPSED_TIME / 1000) AS DURATION_SECONDS,
        ROUND(CREDITS_USED_CLOUD_SERVICES, 2) AS CREDITS_USED,
        LEFT(QUERY_TEXT, 200) AS QUERY_TEXT
      FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
      WHERE WAREHOUSE_NAME = '${warehouseName.toUpperCase()}'
        AND START_TIME >= DATEADD('minute', -${windowMinutes}, '${failureTimeUtc}')
        AND START_TIME <= DATEADD('minute', ${Math.round(windowMinutes / 4)}, '${failureTimeUtc}')
        AND TOTAL_ELAPSED_TIME > 60000
      ORDER BY TOTAL_ELAPSED_TIME DESC
      LIMIT 20
    `;

    const rows = await executeQuery(creds, sql);

    const concurrentQueries = rows.map(row => ({
      queryId: String(row['QUERY_ID'] ?? ''),
      user: String(row['USER_NAME'] ?? ''),
      warehouseName: String(row['WAREHOUSE_NAME'] ?? warehouseName),
      status: String(row['EXECUTION_STATUS'] ?? ''),
      startTime: String(row['START_TIME'] ?? ''),
      durationSeconds: Number(row['DURATION_SECONDS'] ?? 0),
      creditsUsed: Number(row['CREDITS_USED'] ?? 0),
      queryText: String(row['QUERY_TEXT'] ?? ''),
    }));

    const heavyJobs = concurrentQueries.filter(q => q.creditsUsed > 5 || q.durationSeconds > 600);
    return {
      warehouse: warehouseName,
      timeWindowMinutes: windowMinutes,
      concurrentQueries,
      hasContention: heavyJobs.length > 0,
      contentionNote: heavyJobs.length > 0
        ? `⚠️ Contention: ${heavyJobs.map(j => `${j.user} used ${j.creditsUsed} credits (${Math.round(j.durationSeconds / 60)}min)`).join(', ')}`
        : 'No heavy concurrent queries — contention unlikely',
      source: 'live',
    };
  } catch (err) {
    console.error('[snowflake] query history error:', err);
    return {
      warehouse: warehouseName,
      timeWindowMinutes: windowMinutes,
      concurrentQueries: [],
      hasContention: false,
      contentionNote: `Snowflake error: ${err instanceof Error ? err.message : String(err)}`,
      source: 'unavailable',
    };
  }
}
