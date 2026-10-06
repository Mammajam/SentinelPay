import { Pool } from "@neondatabase/serverless";

let pool: Pool | undefined;

/** Lazily-created Neon pool (WebSocket transport; supports transactions). */
export function db(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not configured");
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

export const hasDb = () => Boolean(process.env.DATABASE_URL);
