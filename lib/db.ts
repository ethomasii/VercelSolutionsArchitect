import { neon } from '@neondatabase/serverless';

// Neon serverless driver works in both Node and Edge runtimes.
// DATABASE_URL should point to Neon's PgBouncer pooler endpoint for connection
// reuse across Fluid Compute invocations without managing a pool manually.
// Format: postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/dbname?sslmode=require
export const sql = neon(process.env.DATABASE_URL!);
