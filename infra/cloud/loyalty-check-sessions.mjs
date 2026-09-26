import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
process.umask(0o077);
const mode = process.argv[2];
if (!["create", "revoke"].includes(mode)) throw Error("Use create or revoke");
const path = ".build/cloud/loyalty-check-sessions.json";
if (mode === "create" && existsSync(path))
  throw Error("Check sessions already exist; revoke or reuse them");
const sessions =
  mode === "create"
    ? Object.fromEntries(
        ["customer", "merchant"].map((role) => [
          role,
          { token: randomBytes(32).toString("base64url") },
        ]),
      )
    : JSON.parse(readFileSync(path));
const hashes = Object.fromEntries(
  Object.entries(sessions).map(([role, { token }]) => [
    role,
    createHash("sha256").update(token).digest("hex"),
  ]),
);
const state = JSON.parse(readFileSync(".build/cloud/state.json")),
  outputs = JSON.parse(readFileSync(".build/cloud/outputs.json"));
const aws = (args) =>
  JSON.parse(
    execFileSync(
      "aws",
      [...args, "--region", state.region, "--output", "json"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ) || "{}",
  );
const service = aws([
  "ecs",
  "describe-services",
  "--cluster",
  outputs.ClusterName,
  "--services",
  outputs.ApiServiceName,
]).services[0];
const base = aws([
  "ecs",
  "describe-task-definition",
  "--task-definition",
  service.taskDefinition,
]).taskDefinition;
const allowed = [
  "family",
  "taskRoleArn",
  "executionRoleArn",
  "networkMode",
  "containerDefinitions",
  "volumes",
  "placementConstraints",
  "requiresCompatibilities",
  "cpu",
  "memory",
  "runtimePlatform",
];
const definition = Object.fromEntries(
  Object.entries(base).filter(([k]) => allowed.includes(k)),
);
definition.family = "suica-pay-loyalty-check";
const c = definition.containerDefinitions[0];
c.name = "check";
delete c.healthCheck;
delete c.portMappings;
c.entryPoint = ["node"];
c.command = [
  "--input-type=module",
  "-e",
  `
await(await import('./dist/runtime-secrets.js')).initializeRuntimeEnvironment();
const {pool,transaction}=await import('./dist/db.js');
try{await transaction(async db=>{
 const hashes=${JSON.stringify(hashes)};
 if('${mode}'==='revoke'){
  await db.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=ANY($1::text[])',[Object.values(hashes)]);
  console.log(JSON.stringify({checkSessionsRevoked:true}));return;
 }
 const customer=(await db.query("SELECT a.id FROM accounts a JOIN wallets w ON w.account_id=a.id WHERE a.role='customer' AND a.verified AND lower(w.address)=$1",['0x0f5b208ef5efad4c84105143e38c7e85214db8e0'])).rows[0];
 const merchant=(await db.query("SELECT a.id FROM accounts a JOIN merchant_operators m ON m.account_id=a.id WHERE a.role='merchant' AND m.merchant_id=$1",['97413ff7-483e-473d-8fc9-365db8f0cdb2'])).rows[0];
 if(!customer||!merchant)throw Error('expected_accounts_unavailable');
 for(const [role,account] of Object.entries({customer,merchant}))await db.query("INSERT INTO sessions(token_hash,account_id,expires_at)VALUES($1,$2,now()+interval '2 hours')",[hashes[role],account.id]);
 const pending=(await db.query("SELECT count(*)::int count FROM operator_transactions WHERE address=$1 AND status IN ('signed','pending','reconciling')",['0xd777e6ac65e24f046980d210356df0e6dc2bd64b'])).rows[0].count;
 console.log(JSON.stringify({checkSessionsReady:true,unresolvedOperatorTransactions:pending}));
});}catch{console.error(JSON.stringify({checkSessionFailed:true}));process.exitCode=1;}finally{await pool.end();}
`,
];
const defPath = ".build/cloud/loyalty-session-definition.json";
writeFileSync(defPath, JSON.stringify(definition), { mode: 0o600 });
const registered = aws([
  "ecs",
  "register-task-definition",
  "--cli-input-json",
  `file://${process.cwd()}/${defPath}`,
]).taskDefinition.taskDefinitionArn;
const result = aws([
  "ecs",
  "run-task",
  "--cluster",
  outputs.ClusterName,
  "--task-definition",
  registered,
  "--launch-type",
  "FARGATE",
  "--network-configuration",
  JSON.stringify(service.networkConfiguration),
]);
if (result.failures?.length || !result.tasks[0])
  throw Error("Could not start check session task");
if (mode === "create")
  writeFileSync(path, JSON.stringify(sessions), { mode: 0o600 });
writeFileSync(
  ".build/cloud/task-loyalty-session.json",
  JSON.stringify({
    arn: result.tasks[0].taskArn,
    definition: registered,
    mode: "loyalty-session",
  }),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({ checkSessionTask: result.tasks[0].taskArn, mode }),
);
