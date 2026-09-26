import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  required,
  credentials,
  cloudConfig,
  verificationConfig,
  applicationObjects,
  restoreList,
  command,
  restoreEnvironment,
  prepareApplicationRole,
  grantApplicationObjects,
  databaseDigests,
  safeFailure,
} from "./database-tools.mjs";

let stage = "configuration",
  directory,
  restoreVerificationConfig;
try {
  const mode = required("MIGRATION_MODE");
  if (!["restore", "verify"].includes(mode))
    throw new Error("Invalid migration mode");
  if (mode === "restore") {
    if (process.env.CONFIRM_RESTORE !== "suicapay")
      throw new Error("Restore not confirmed");
    stage = "secrets";
    const master = await credentials(required("RDS_MASTER_SECRET_ARN"));
    const app = await credentials(required("DATABASE_SECRET_ARN"));
    const config = await cloudConfig(master);
    restoreVerificationConfig = await cloudConfig(app);
    const objects = await applicationObjects();
    directory = await mkdtemp(join(tmpdir(), "suica-database-"));
    const dump = join(directory, "application.dump"),
      list = join(directory, "restore.list");
    stage = "download";
    let dumpStream, s3;
    if (process.env.MIGRATION_BUCKET || process.env.MIGRATION_KEY) {
      s3 = new S3Client({});
      try {
        const response = await s3.send(
          new GetObjectCommand({
            Bucket: required("MIGRATION_BUCKET"),
            Key: required("MIGRATION_KEY"),
          }),
          { abortSignal: AbortSignal.timeout(300000) },
        );
        if (!response.Body) throw new Error("Dump download failed");
        dumpStream = response.Body;
      } catch {
        s3.destroy();
        throw new Error("Dump download failed");
      }
    } else {
      const dumpURL = new URL(required("MIGRATION_DUMP_URL"));
      if (
        dumpURL.protocol !== "https:" ||
        dumpURL.username ||
        dumpURL.password ||
        dumpURL.hash ||
        (dumpURL.port && dumpURL.port !== "443") ||
        !/(?:^|\.)s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(dumpURL.hostname)
      )
        throw new Error("Expected HTTPS S3 dump URL");
      const response = await fetch(dumpURL, {
        redirect: "error",
        signal: AbortSignal.timeout(300000),
      });
      if (!response.ok || !response.body)
        throw new Error("Dump download failed");
      dumpStream = Readable.fromWeb(response.body);
    }
    let size = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        callback(
          size > 2 * 1024 ** 3 ? new Error("Dump too large") : null,
          chunk,
        );
      },
    });
    try {
      await pipeline(
        dumpStream,
        limiter,
        createWriteStream(dump, { mode: 0o600 }),
      );
    } finally {
      s3?.destroy();
    }
    stage = "archive_validation";
    const archive = await command("pg_restore", ["--list", dump]);
    await writeFile(list, restoreList(archive.stdout, objects), {
      mode: 0o600,
    });
    stage = "application_role";
    const client = new pg.Client(config);
    await client.connect();
    try {
      await prepareApplicationRole(client, app, config.database);
      stage = "restore";
      await command(
        "pg_restore",
        [
          "--clean",
          "--if-exists",
          "--no-owner",
          "--no-acl",
          "--single-transaction",
          "--exit-on-error",
          "--role=suica_app",
          "--use-list",
          list,
          "--dbname",
          config.database,
          dump,
        ],
        {
          env: restoreEnvironment(config, required("DATABASE_SSL_CA_FILE")),
          timeout: 15 * 60 * 1000,
        },
      );
      stage = "application_grants";
      await grantApplicationObjects(client, objects);
    } finally {
      await client.end();
    }
  }
  stage = "verify";
  const tables = await databaseDigests(
    restoreVerificationConfig ?? (await verificationConfig()),
  );
  for (const table of tables) console.log(JSON.stringify(table));
} catch {
  safeFailure(stage);
  process.exitCode = 1;
} finally {
  if (directory)
    await rm(directory, { recursive: true, force: true }).catch(() => {});
}
