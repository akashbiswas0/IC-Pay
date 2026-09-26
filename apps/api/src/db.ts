import pg from "pg";
import { config } from "./config.js";
import { databaseOptions } from "./database-options.js";
export const pool = new pg.Pool({
  ...databaseOptions(config.DATABASE_URL, config.DATABASE_SSL_CA_FILE),
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});
// pg-pool has already removed the broken idle client before emitting this event.
// Active query failures still reject normally; never log the attached client/details.
pool.on("error", (error) => {
  const name =
    typeof error.name === "string" &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
      ? error.name
      : "Error";
  const candidate = (error as Error & { code?: unknown }).code;
  const code =
    typeof candidate === "string" && /^[A-Z0-9_]{1,32}$/.test(candidate)
      ? candidate
      : "UNKNOWN";
  console.error("PostgreSQL idle connection error", { name, code });
});
export async function transaction<T>(
  fn: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

/** Serializes direct KMS signing with operator commands for the same EVM account. */
export async function withWalletLock<T>(
  address: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await pool.connect();
  let acquired = false;
  try {
    acquired = (
      await lock.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        [address.toLowerCase()],
      )
    ).rows[0].locked;
    if (!acquired) throw new Error("Wallet signing is already in progress");
    return await fn();
  } finally {
    try {
      if (acquired)
        await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          address.toLowerCase(),
        ]);
    } finally {
      lock.release();
    }
  }
}
