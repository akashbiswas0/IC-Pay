import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
const groups = {
  "Database and card lookup": ["DATABASE_URL", "CARD_HMAC_SECRET"],
  "World verification": ["WORLD_APP_ID", "WORLD_RP_ID", "WORLD_SIGNING_KEY"],
  "Testnet settlement": [
    "CHAIN_ID",
    "TOKEN_ADDRESS",
    "PAYMENT_ADDRESS",
    "MULTIBAAS_URL",
    "MULTIBAAS_API_KEY",
  ],
  "AWS KMS signing": ["AWS_REGION", "AWS_KMS_OPERATOR_KEY_ID"],
  "Event webhooks": ["MULTIBAAS_WEBHOOK_SECRET"],
};
let incomplete = false;
for (const [label, keys] of Object.entries(groups)) {
  const missing = keys.filter((key) => !process.env[key]?.trim());
  console.log(
    `${missing.length ? "SETUP" : "SET"} ${label}${missing.length ? `: add ${missing.join(", ")}` : ""}`,
  );
  incomplete ||= missing.length > 0;
}
console.log(
  "AWS credentials use the SDK default credential chain. This checks presence only. Run the live connection checks before accepting payments.",
);
process.exitCode = incomplete ? 1 : 0;
