import {
  databaseDigests,
  verificationConfig,
  safeFailure,
} from "./database-tools.mjs";
try {
  const tables = await databaseDigests(await verificationConfig());
  for (const table of tables) console.log(JSON.stringify(table));
} catch {
  safeFailure("verify");
  process.exitCode = 1;
}
