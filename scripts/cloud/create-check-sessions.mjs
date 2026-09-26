import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import dotenv from "dotenv";
import pg from "pg";
if (existsSync(".build/cloud/check-sessions.json"))
  throw Error("Check sessions already exist");
const env = dotenv.parse(readFileSync(".env"));
const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
try {
  await db.query("BEGIN");
  const customer = (
    await db.query(
      "SELECT a.id FROM accounts a JOIN wallets w ON w.account_id=a.id WHERE a.role='customer' AND a.verified=true AND lower(w.address)=$1",
      ["0x0f5b208ef5efad4c84105143e38c7e85214db8e0"],
    )
  ).rows[0];
  const merchant = (
    await db.query(
      "SELECT a.id FROM accounts a JOIN merchant_operators o ON o.account_id=a.id WHERE o.merchant_id=$1",
      ["97413ff7-483e-473d-8fc9-365db8f0cdb2"],
    )
  ).rows[0];
  if (!customer || !merchant)
    throw Error("Expected existing customer and merchant");
  const data = {};
  for (const [role, account] of Object.entries({ customer, merchant })) {
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    await db.query(
      "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '2 hours')",
      [hash, account.id],
    );
    data[role] = { accountId: account.id, token };
  }
  writeFileSync(".build/cloud/check-sessions.json", JSON.stringify(data), {
    mode: 0o600,
  });
  await db.query("COMMIT");
  console.log(
    "Created two temporary migration check sessions. Tokens stored privately.",
  );
} catch (e) {
  await db.query("ROLLBACK");
  throw e;
} finally {
  await db.end();
}
