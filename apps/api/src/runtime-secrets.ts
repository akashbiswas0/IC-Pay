import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
export class RuntimeInitializationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "RuntimeInitializationError";
  }
}
const allowed = new Set([
  "LOYALTY_PAYMENT_ADDRESS",
  "LOYALTY_PAYMENT_CONTRACT",
  "TEST_FUNDING_ENABLED",
  "TEST_FUNDING_DAILY_LIMIT",
  "DATABASE_URL",
  "DATABASE_SSL_CA_FILE",
  "DATABASE_HOST",
  "DATABASE_PORT",
  "DATABASE_NAME",
  "CARD_HMAC_SECRET",
  "HOST",
  "PORT",
  "CORS_ORIGIN",
  "TRUST_PROXY_HOPS",
  "CHAIN_ID",
  "TOKEN_ADDRESS",
  "TOKEN_SYMBOL",
  "TOKEN_NAME",
  "TOKEN_ONCHAIN_SYMBOL",
  "TOKEN_DECIMALS",
  "PAYMENT_ADDRESS",
  "PAYMENT_CONTRACT",
  "TOKEN_CONTRACT",
  "REWARD_PAYMENT_ADDRESS",
  "COLLECTIBLE_PAYMENT_ADDRESS",
  "COLLECTIBLE_PAYMENT_CONTRACT",
  "COLLECTIBLE_ARTWORK_BASE_URL",
  "REWARD_PAYMENT_CONTRACT",
  "REWARD_READ_MODE",
  "REWARD_READ_RPC_URL",
  "EXPLORER_URL",
  "BALANCE_RPC_URL",
  "MULTIBAAS_URL",
  "MULTIBAAS_API_KEY",
  "MULTIBAAS_HISTORY_URL",
  "MULTIBAAS_HISTORY_API_KEY",
  "MULTIBAAS_WEBHOOK_SECRET",
  "AWS_REGION",
  "AWS_KMS_OPERATOR_KEY_ID",
  "WORLD_APP_ID",
  "WORLD_RP_ID",
  "WORLD_SIGNING_KEY",
  "WORLD_STAGING_VERIFICATION_TOKEN",
  "WORLD_ENVIRONMENT",
  "CONFIRMATIONS",
  "SESSION_HOURS",
]);
const deploymentKeys = new Set([
  "TOKEN_SYMBOL",
  "TOKEN_NAME",
  "TOKEN_ONCHAIN_SYMBOL",
  "LOYALTY_PAYMENT_ADDRESS",
  "LOYALTY_PAYMENT_CONTRACT",
  "COLLECTIBLE_PAYMENT_ADDRESS",
  "COLLECTIBLE_PAYMENT_CONTRACT",
  "COLLECTIBLE_ARTWORK_BASE_URL",
  "TEST_FUNDING_ENABLED",
  "TEST_FUNDING_DAILY_LIMIT",
  "HOST",
  "PORT",
  "TRUST_PROXY_HOPS",
  "DATABASE_SSL_CA_FILE",
  "DATABASE_HOST",
  "DATABASE_PORT",
  "DATABASE_NAME",
  "AWS_REGION",
]);
export function parseSecretArn(value: string) {
  const match =
    /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:([a-z0-9-]+):[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/.exec(
      value,
    );
  if (!match) throw new RuntimeInitializationError("invalid_secret_arn");
  return { arn: value, region: match[2]! };
}
function objectJSON(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
      throw new Error();
    return parsed;
  } catch {
    throw new RuntimeInitializationError("invalid_secret_json");
  }
}
export function parseRuntimeSecret(value: string): Record<string, string> {
  const parsed = objectJSON(value),
    result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (!allowed.has(key))
      throw new RuntimeInitializationError("unsupported_runtime_secret_key");
    if (typeof entry !== "string" || entry.includes("\0"))
      throw new RuntimeInitializationError("invalid_runtime_secret_value");
    result[key] = entry;
  }
  return result;
}
export function applyRuntimeSecret(
  values: Record<string, string>,
  environment: NodeJS.ProcessEnv,
) {
  for (const [key, value] of Object.entries(values))
    if (!deploymentKeys.has(key) || environment[key] === undefined)
      environment[key] = value;
}
export function databaseURLFromSecret(
  value: string,
  environment: NodeJS.ProcessEnv,
): string {
  const secret = objectJSON(value);
  const username = secret.username,
    password = secret.password;
  if (
    typeof username !== "string" ||
    !username ||
    typeof password !== "string" ||
    !password ||
    username.includes("\0") ||
    password.includes("\0")
  )
    throw new RuntimeInitializationError("invalid_database_secret");
  const host = environment.DATABASE_HOST,
    name = environment.DATABASE_NAME,
    port = environment.DATABASE_PORT ?? "5432";
  if (
    !host ||
    !/^[a-zA-Z0-9.-]+$/.test(host) ||
    !name ||
    !/^[a-zA-Z0-9_-]+$/.test(name) ||
    !/^\d+$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535
  )
    throw new RuntimeInitializationError("invalid_database_endpoint");
  if (!environment.DATABASE_SSL_CA_FILE)
    throw new RuntimeInitializationError("database_tls_ca_required");
  const url = new URL(`postgresql://${host}:${port}/${name}`);
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(password);
  return url.toString();
}
async function fetchSecret(arn: string) {
  const parsed = parseSecretArn(arn);
  const client = new SecretsManagerClient({ region: parsed.region });
  try {
    const response = await client.send(
      new GetSecretValueCommand({
        SecretId: parsed.arn,
        VersionStage: "AWSCURRENT",
      }),
    );
    if (response.ARN !== parsed.arn)
      throw new RuntimeInitializationError("secret_identity_mismatch");
    const value =
      response.SecretString ??
      (response.SecretBinary
        ? Buffer.from(response.SecretBinary).toString("utf8")
        : undefined);
    if (value === undefined)
      throw new RuntimeInitializationError("secret_payload_missing");
    return value;
  } catch (error) {
    if (error instanceof RuntimeInitializationError) throw error;
    throw new RuntimeInitializationError("secret_fetch_failed");
  } finally {
    client.destroy();
  }
}
/** No configuration, database or app module is imported before these secret loads finish. */
export async function initializeRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  // Capture pinned resource identities before applying the runtime payload. Payloads cannot redirect secret reads.
  const runtimeArn = environment.RUNTIME_SECRET_ARN,
    databaseArn = environment.DATABASE_SECRET_ARN;
  if (runtimeArn) {
    const values = parseRuntimeSecret(await fetchSecret(runtimeArn));
    applyRuntimeSecret(values, environment);
  }
  if (databaseArn)
    environment.DATABASE_URL = databaseURLFromSecret(
      await fetchSecret(databaseArn),
      environment,
    );
}
