import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const exec = promisify(execFile);
export function required(name, env = process.env) {
  if (!env[name]) throw new Error(`Missing ${name}`);
  return env[name];
}
export function safeFailure(stage) {
  // Never print provider errors, SQL, connection strings, dump URLs or row contents.
  console.error(JSON.stringify({ status: "failed", stage }));
}
export async function credentials(arn) {
  const client = new SecretsManagerClient({});
  try {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: arn }),
    );
    const secret = JSON.parse(result.SecretString ?? "");
    if (
      typeof secret.username !== "string" ||
      !secret.username ||
      typeof secret.password !== "string" ||
      !secret.password ||
      secret.username.includes("\0") ||
      secret.password.includes("\0")
    )
      throw new Error("Invalid database secret");
    return secret;
  } finally {
    client.destroy();
  }
}
export async function cloudConfig(secret, env = process.env) {
  const host = required("DATABASE_HOST", env);
  const port = Number(env.DATABASE_PORT ?? "5432");
  if (
    !/^[a-zA-Z0-9.-]+$/.test(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("Invalid database endpoint");
  return {
    host,
    port,
    database: required("DATABASE_NAME", env),
    user: secret.username,
    password: secret.password,
    ssl: {
      rejectUnauthorized: true,
      ca: await readFile(required("DATABASE_SSL_CA_FILE", env), "utf8"),
    },
    connectionTimeoutMillis: 15000,
  };
}
export async function verificationConfig(env = process.env) {
  if (env.DATABASE_URL) {
    const url = new URL(env.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol))
      throw new Error("Invalid database URL");
    if (env.DATABASE_SSL_CA_FILE) {
      // pg connection-string SSL options must not override verified TLS.
      for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl"])
        url.searchParams.delete(key);
      return {
        connectionString: url.href,
        connectionTimeoutMillis: 15000,
        ssl: {
          rejectUnauthorized: true,
          ca: await readFile(env.DATABASE_SSL_CA_FILE, "utf8"),
        },
      };
    }
    return { connectionString: url.href, connectionTimeoutMillis: 15000 };
  }
  return cloudConfig(
    await credentials(required("DATABASE_SECRET_ARN", env)),
    env,
  );
}
export async function applicationObjects() {
  const directory = new URL("../../apps/api/migrations/", import.meta.url);
  const sources = await Promise.all(
    (await readdir(directory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort()
      .map((name) => readFile(new URL(name, directory), "utf8")),
  );
  const sql = sources.join("\n");
  const tables = new Set([
    "schema_migrations",
    ...[
      ...sql.matchAll(
        /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gi,
      ),
    ].map((match) => match[1]),
  ]);
  const indexes = new Set(
    [
      ...sql.matchAll(
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)\s+ON/gi,
      ),
    ].map((match) => match[1]),
  );
  return {
    tables,
    indexes,
    sequences: new Set(["audit_events_id_seq", "auth_attempts_id_seq"]),
  };
}
export function restoreList(list, objects) {
  const entries = [],
    seenTables = new Set(),
    seenData = new Set(),
    seenSequences = new Set(),
    seenSequenceValues = new Set();
  for (const line of list.split("\n")) {
    if (!line || line.startsWith(";")) continue;
    const match = line.match(
      /^\d+;\s+\d+\s+\d+\s+(TABLE DATA|SEQUENCE OWNED BY|SEQUENCE SET|FK CONSTRAINT|TABLE|SEQUENCE|INDEX|CONSTRAINT|DEFAULT)\s+public\s+(\S+)(?:\s|$)/,
    );
    if (!match) continue; // Never restore databases, schemas, extensions, ACLs or executable functions.
    const [, kind, name] = match;
    const allowed = kind.startsWith("SEQUENCE")
      ? objects.sequences.has(name)
      : kind === "INDEX"
        ? objects.indexes.has(name)
        : objects.tables.has(name);
    if (!allowed) continue;
    entries.push(line);
    if (kind === "TABLE") seenTables.add(name);
    if (kind === "TABLE DATA") seenData.add(name);
    if (kind === "SEQUENCE") seenSequences.add(name);
    if (kind === "SEQUENCE SET") seenSequenceValues.add(name);
  }
  // A partial dump cannot accidentally replace a full application database.
  for (const table of objects.tables)
    if (!seenTables.has(table) || !seenData.has(table))
      throw new Error("Incomplete application dump");
  for (const sequence of objects.sequences)
    if (!seenSequences.has(sequence) || !seenSequenceValues.has(sequence))
      throw new Error("Incomplete application sequence dump");
  return entries.join("\n") + "\n";
}
export async function command(file, args, options = {}) {
  // Child stderr can contain COPY data or passwords from errors; never surface it.
  try {
    return await exec(file, args, { maxBuffer: 8 * 1024 * 1024, ...options });
  } catch {
    throw new Error("Database command failed");
  }
}
export function restoreEnvironment(config, caFile, env = process.env) {
  const result = Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("PG")),
  );
  return {
    ...result,
    PGHOST: config.host,
    PGPORT: String(config.port),
    PGDATABASE: config.database,
    PGUSER: config.user,
    PGPASSWORD: config.password,
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: caFile,
    PGCONNECT_TIMEOUT: "15",
  };
}
export async function prepareApplicationRole(client, app, database) {
  if (app.username !== "suica_app") throw new Error("Expected suica_app role");
  const role = pg.escapeIdentifier(app.username);
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
    app.username,
  ]);
  if (exists.rowCount) {
    const attributes = (
      await client.query(
        "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=$1",
        [app.username],
      )
    ).rows[0];
    if (Object.values(attributes).some(Boolean))
      throw new Error("Application role has unexpected privileges");
    // RDS administrators cannot alter replication attributes, even to disable them.
    await client.query(
      `ALTER ROLE ${role} LOGIN PASSWORD ${pg.escapeLiteral(app.password)}`,
    );
  } else {
    await client.query(
      `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${pg.escapeLiteral(app.password)}`,
    );
  }
  const master = (await client.query("SELECT current_user AS name")).rows[0]
    .name;
  await client.query(`GRANT ${role} TO ${pg.escapeIdentifier(master)}`);
  await client.query(
    `GRANT CONNECT, CREATE ON DATABASE ${pg.escapeIdentifier(database)} TO ${role}`,
  );
  await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
}
export async function grantApplicationObjects(client, objects) {
  for (const table of objects.tables)
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${pg.escapeIdentifier(table)} TO suica_app`,
    );
  for (const sequence of objects.sequences)
    await client.query(
      `GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.${pg.escapeIdentifier(sequence)} TO suica_app`,
    );
}
export async function databaseDigests(config) {
  const client = new pg.Client(config);
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
    await client.query("SET LOCAL IntervalStyle = 'postgres'");
    await client.query("SET LOCAL extra_float_digits = 3");
    const { tables, sequences } = await applicationObjects();
    const result = [];
    for (const table of [...tables].sort()) {
      const hashes = [];
      await client.query(
        `DECLARE digest_rows NO SCROLL CURSOR FOR SELECT to_jsonb(row_value)::text AS canonical_json FROM public.${pg.escapeIdentifier(table)} AS row_value`,
      );
      while (true) {
        const page = await client.query("FETCH FORWARD 1000 FROM digest_rows");
        if (!page.rowCount) break;
        for (const row of page.rows)
          hashes.push(
            createHash("sha256").update(row.canonical_json, "utf8").digest(),
          );
      }
      await client.query("CLOSE digest_rows");
      hashes.sort(Buffer.compare);
      const digest = createHash("sha256");
      for (const hash of hashes) digest.update(hash);
      result.push({
        table,
        count: hashes.length,
        sha256: digest.digest("hex"),
      });
    }
    // Sequence state is not MVCC: callers must stop writers before the final dump/comparison.
    for (const sequence of [...sequences].sort()) {
      const state = (
        await client.query(
          `SELECT last_value::text AS last_value, is_called FROM public.${pg.escapeIdentifier(sequence)}`,
        )
      ).rows[0];
      result.push({
        sequence,
        sha256: createHash("sha256")
          .update(JSON.stringify(state))
          .digest("hex"),
      });
    }
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}
