import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyRuntimeSecret,
  databaseURLFromSecret,
  parseRuntimeSecret,
  parseSecretArn,
} from "../src/runtime-secrets.js";
import { databaseOptions } from "../src/database-options.js";
import {
  recordWorkerProgress,
  clearWorkerProgress,
  workerHealthy,
} from "../src/worker-health.js";

test("runtime secret validates types and rejects process controls or redirected secret resources", () => {
  for (const key of [
    "NODE_OPTIONS",
    "AWS_ACCESS_KEY_ID",
    "RUNTIME_SECRET_ARN",
    "DATABASE_SECRET_ARN",
    "__proto__",
  ])
    assert.throws(
      () => parseRuntimeSecret(JSON.stringify({ [key]: "untrusted" })),
      /unsupported_runtime_secret_key/,
    );
  for (const value of [
    "[]",
    "null",
    '{"PORT":3001}',
    '{"CARD_HMAC_SECRET":"\\u0000"}',
  ])
    assert.throws(() => parseRuntimeSecret(value));
  assert.deepEqual(
    parseRuntimeSecret('{"CARD_HMAC_SECRET":"secret-value","PORT":"3001"}'),
    { CARD_HMAC_SECRET: "secret-value", PORT: "3001" },
  );
  assert.equal(
    parseSecretArn(
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:suica/runtime-ABC123",
    ).region,
    "us-east-1",
  );
  assert.throws(() => parseSecretArn("suica/runtime"), /invalid_secret_arn/);
});
test("deployment endpoint stays authoritative while fetched secrets replace stale credentials", () => {
  const environment = {
    HOST: "0.0.0.0",
    PORT: "3001",
    TRUST_PROXY_HOPS: "2",
    DATABASE_HOST: "cloud.example",
    CARD_HMAC_SECRET: "stale",
  };
  applyRuntimeSecret(
    parseRuntimeSecret(
      JSON.stringify({
        HOST: "127.0.0.1",
        PORT: "1234",
        TRUST_PROXY_HOPS: "0",
        DATABASE_HOST: "localhost",
        CARD_HMAC_SECRET: "current",
      }),
    ),
    environment,
  );
  assert.deepEqual(environment, {
    HOST: "0.0.0.0",
    PORT: "3001",
    TRUST_PROXY_HOPS: "2",
    DATABASE_HOST: "cloud.example",
    CARD_HMAC_SECRET: "current",
  });
});
test("database secret safely encodes credentials and requires an explicit TLS trust file", () => {
  const environment = {
    DATABASE_HOST: "database.example",
    DATABASE_NAME: "suica_payments",
    DATABASE_SSL_CA_FILE: "/app/certs/global-bundle.pem",
  };
  const encoded = new URL(
    databaseURLFromSecret(
      JSON.stringify({
        username: "user@name",
        password: "p:/@?#%word",
        host: "untrusted.example",
      }),
      environment,
    ),
  );
  assert.equal(decodeURIComponent(encoded.username), "user@name");
  assert.equal(decodeURIComponent(encoded.password), "p:/@?#%word");
  assert.equal(encoded.hostname, "database.example");
  assert.equal(encoded.port, "5432");
  assert.throws(
    () =>
      databaseURLFromSecret('{"username":"u","password":"p"}', {
        ...environment,
        DATABASE_SSL_CA_FILE: undefined,
      }),
    /database_tls_ca_required/,
  );
  assert.throws(
    () =>
      databaseURLFromSecret('{"username":"u","password":"p"}', {
        ...environment,
        DATABASE_HOST: "host/path",
      }),
    /invalid_database_endpoint/,
  );
});
test("PostgreSQL TLS uses the actual RDS CA bundle and rejects URL downgrade overrides", async () => {
  const ca = fileURLToPath(
    new URL("../certs/global-bundle.pem", import.meta.url),
  );
  const options = databaseOptions(
    "postgresql://user:password@sample.rds.amazonaws.com/db",
    ca,
  );
  assert.equal(typeof options.ssl, "object");
  assert.equal(
    (options.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized,
    true,
  );
  assert.throws(
    () => databaseOptions("postgresql://sample.rds.amazonaws.com/db"),
    /explicit trusted CA/,
  );
  for (const query of [
    "sslmode=disable",
    "sslmode=no-verify",
    "sslrootcert=other",
    "uselibpqcompat=true",
  ])
    assert.throws(
      () => databaseOptions(`postgresql://localhost/db?${query}`, ca),
      /URL SSL parameters/,
    );
  const directory = await mkdtemp(join(tmpdir(), "suica-ca-"));
  try {
    const invalid = join(directory, "invalid.pem");
    await writeFile(invalid, "not a certificate");
    assert.throws(
      () => databaseOptions("postgresql://localhost/db", invalid),
      /no certificates/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("worker health requires fresh progress from a living process and clears on shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "suica-worker-health-"));
  const path = join(directory, "health.json");
  try {
    assert.equal(await workerHealthy(Date.now(), path), false);
    await recordWorkerProgress(path);
    assert.equal(await workerHealthy(Date.now(), path), true);
    assert.equal(await workerHealthy(Date.now() + 121000, path), false);
    await clearWorkerProgress(path);
    assert.equal(await workerHealthy(Date.now(), path), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test(
  "readiness queries real PostgreSQL and fails safely when the pool is closed",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    assert.equal(
      new URL(process.env.TEST_DATABASE_URL!).pathname,
      "/suica_payments_test",
    );
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.DATABASE_SSL_CA_FILE = "";
    const { pool } = await import("../src/db.js");
    const { buildServer } = await import("../src/server.js");
    const app = await buildServer();
    try {
      assert.equal(
        (await pool.query("SELECT current_database() name")).rows[0].name,
        "suica_payments_test",
      );
      for (const path of ["/health", "/health/ready", "/health/live"]) {
        const response = await app.inject({ url: path });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers["cache-control"], "private, no-store");
      }
      await pool.end();
      const unavailable = await app.inject({ url: "/health/ready" });
      assert.equal(unavailable.statusCode, 503);
      assert.deepEqual(unavailable.json(), { status: "not_ready" });
      assert.equal((await app.inject({ url: "/health/live" })).statusCode, 200);
    } finally {
      await app.close();
      if (!pool.ended) await pool.end();
    }
  },
);
