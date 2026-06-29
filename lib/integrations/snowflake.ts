// Snowflake integration — ACCOUNT_USAGE for warehouse contention, query history.
//
// SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY is the gold mine for diagnosing:
// - Which queries ran concurrently with the failing job
// - Warehouse credit consumption (who's hogging the warehouse)
// - Query execution time anomalies
//
// Note: ACCOUNT_USAGE has a ~45min lag. For real-time, use INFORMATION_SCHEMA.QUERY_HISTORY
// (only shows your own queries, no lag).

import { getSetting } from '../settings';

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
  source: 'live' | 'unavailable';
}

async function getSnowflakeCredentials(): Promise<{
  account: string; user: string; password: string; warehouse: string;
} | null> {
  const account = await getSetting('snowflake', 'SNOWFLAKE_ACCOUNT');
  const user = await getSetting('snowflake', 'SNOWFLAKE_USER');
  const password = await getSetting('snowflake', 'SNOWFLAKE_PASSWORD');
  const warehouse = await getSetting('snowflake', 'SNOWFLAKE_WAREHOUSE');
  if (!account || !user || !password) return null;
  return { account, user, password, warehouse: warehouse ?? 'COMPUTE_WH' };
}

// Query SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY for warehouse contention
// around the time of a failure.
//
// Real implementation: use @snowflake-labs/snowflake-connector-nodejs or
// Snowflake REST SQL API (https://docs.snowflake.com/en/developer-guide/sql-api/intro)
export async function getWarehouseContention(
  warehouseName: string,
  failureTimeUtc: string,
  windowMinutes = 120
): Promise<WarehouseContention> {
  const creds = await getSnowflakeCredentials();

  if (!creds) {
    return {
      warehouse: warehouseName,
      timeWindowMinutes: windowMinutes,
      concurrentQueries: [],
      hasContention: false,
      contentionNote: 'Snowflake credentials not configured — add SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PASSWORD in /settings',
      source: 'unavailable',
    };
  }

  // TODO: Replace with real Snowflake REST SQL API call:
  // POST https://{account}.snowflakecomputing.com/api/v2/statements
  // with SQL: SELECT query_id, user_name, warehouse_name, execution_status,
  //           start_time, total_elapsed_time, credits_used_cloud_services, query_text
  //           FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
  //           WHERE warehouse_name = '{warehouseName}'
  //             AND start_time BETWEEN DATEADD(minute, -{windowMinutes}, '{failureTimeUtc}')
  //                                AND DATEADD(minute, {windowMinutes/2}, '{failureTimeUtc}')
  //           ORDER BY start_time DESC LIMIT 20

  return {
    warehouse: warehouseName,
    timeWindowMinutes: windowMinutes,
    concurrentQueries: [],
    hasContention: false,
    contentionNote: 'Snowflake connector configured but REST SQL API not yet implemented. See lib/integrations/snowflake.ts TODO.',
    source: 'unavailable',
  };
}
