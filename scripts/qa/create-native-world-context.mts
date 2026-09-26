import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { signWorldRequest } from "../../apps/api/src/protocol.js";
process.loadEnvFile(".env");
const {
  WORLD_APP_ID: appId,
  WORLD_RP_ID: rpId,
  WORLD_SIGNING_KEY: key,
  WORLD_ENVIRONMENT: environment,
} = process.env;
if (
  !appId ||
  !rpId ||
  !key ||
  !["production", "staging"].includes(environment ?? "")
)
  throw new Error("Configure the real World RP first.");
const output = process.argv[2];
if (!output) throw new Error("Pass a local context output path.");
const signature = await signWorldRequest(key);
await writeFile(
  output,
  JSON.stringify({
    id: randomUUID(),
    purpose: "enrollment",
    appId,
    environment,
    sessionId: null,
    rpContext: { rp_id: rpId, ...signature },
  }),
  { mode: 0o600 },
);
console.log(
  "Real short-lived RP context written for native SDK bridge smoke; no application account or card was created.",
);
