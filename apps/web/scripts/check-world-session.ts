import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { signWorldRequest } from "../../api/src/protocol.js";

// Creates a real short-lived RP context for the browser SDK check. This is not
// a card enrollment or a fabricated identity proof. Never publish this file.
process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
const {
  WORLD_APP_ID: appId,
  WORLD_RP_ID: rpId,
  WORLD_SIGNING_KEY: key,
  WORLD_ENVIRONMENT: environment,
} = process.env;
if (!appId?.startsWith("app_") || !rpId?.startsWith("rp_") || !key)
  throw new Error("World RP configuration is required.");
if (environment !== "production" && environment !== "staging")
  throw new Error("An explicit World environment is required.");
const signature = await signWorldRequest(key);
const config = {
  app_id: appId,
  rp_context: { rp_id: rpId, ...signature },
  environment,
};
await writeFile(
  new URL("../qa/world-context.local.json", import.meta.url),
  JSON.stringify(config),
  { mode: 0o600 },
);
console.log(
  "Fresh RP context generated for the local browser SDK check; expires in five minutes. No card account or proof was created.",
);
