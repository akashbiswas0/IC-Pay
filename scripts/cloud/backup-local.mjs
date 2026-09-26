import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import dotenv from "dotenv";
const env = dotenv.parse(readFileSync(".env"));
const url = new URL(env.DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname))
  throw Error("Expected local source database");
const state = JSON.parse(readFileSync(".build/cloud/state.json"));
const tag = process.argv[2];
if (!/^[a-z0-9-]+$/.test(tag || "")) throw Error("Expected backup label");
const file = `.build/cloud/${tag}.dump`;
const childEnv = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || "5432",
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
};
try {
  execFileSync(
    "pg_dump",
    ["--format=custom", "--no-owner", "--no-acl", "--file", file],
    { env: childEnv, stdio: "pipe" },
  );
} catch {
  throw Error("Local database backup failed");
}
chmodSync(file, 0o600);
const result = execFileSync(
  process.execPath,
  ["scripts/cloud/verify-database.mjs"],
  {
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
    encoding: "utf8",
    stdio: "pipe",
  },
);
writeFileSync(`.build/cloud/${tag}-digests.jsonl`, result, { mode: 0o600 });
const key = `suica-pay/migration/${tag}.dump`;
execFileSync(
  "aws",
  [
    "s3",
    "cp",
    file,
    `s3://${state.bucket}/${key}`,
    "--region",
    state.region,
    "--only-show-errors",
  ],
  { stdio: "pipe" },
);
console.log(JSON.stringify({ backup: file, bucket: state.bucket, key }));
