import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
process.umask(0o077);
const s = JSON.parse(readFileSync(".build/cloud/state.json"));
const o = JSON.parse(readFileSync(".build/cloud/outputs.json"));
const aws = (args) =>
  JSON.parse(
    execFileSync("aws", [...args, "--region", s.region, "--output", "json"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }) || "{}",
  );
const path = ".build/cloud/funding-check-session.json";
if (existsSync(path))
  throw Error(
    "A funding check session already exists; reuse or revoke it first",
  );
const token = randomBytes(32).toString("base64url"),
  hash = createHash("sha256").update(token).digest("hex");
const base = aws([
  "ecs",
  "describe-task-definition",
  "--task-definition",
  o.ApiTaskDefinitionArn,
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
const d = Object.fromEntries(
  Object.entries(base).filter(([k]) => allowed.includes(k)),
);
d.family = "suica-pay-funding-check";
const c = d.containerDefinitions[0];
c.name = "check";
delete c.healthCheck;
delete c.portMappings;
c.entryPoint = ["node"];
c.command = [
  "--input-type=module",
  "-e",
  `await (await import('./dist/runtime-secrets.js')).initializeRuntimeEnvironment();const {pool,transaction}=await import('./dist/db.js');try{await transaction(async(db)=>{const a=(await db.query("SELECT a.id FROM accounts a JOIN wallets w ON w.account_id=a.id WHERE a.role='customer' AND a.verified AND lower(w.address)=$1",['0x0f5b208ef5efad4c84105143e38c7e85214db8e0'])).rows[0];if(!a)throw Error('Existing verified customer not found');await db.query("INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '2 hours')",['${hash}',a.id]);console.log(JSON.stringify({checkSessionReady:true}));});}finally{await pool.end();}`,
];
writeFileSync(".build/cloud/funding-check-definition.json", JSON.stringify(d), {
  mode: 0o600,
});
const def = aws([
  "ecs",
  "register-task-definition",
  "--cli-input-json",
  `file://${process.cwd()}/.build/cloud/funding-check-definition.json`,
]).taskDefinition.taskDefinitionArn;
const r = aws([
  "ecs",
  "run-task",
  "--cluster",
  o.ClusterName,
  "--task-definition",
  def,
  "--launch-type",
  "FARGATE",
  "--network-configuration",
  JSON.stringify({
    awsvpcConfiguration: {
      subnets: ["subnet-0e2f06fd11628f8f6", "subnet-09045931cd077fb33"],
      securityGroups: [o.TaskSecurityGroupId],
      assignPublicIp: "ENABLED",
    },
  }),
]);
if (r.failures?.length || !r.tasks?.[0])
  throw Error("Session check task could not start");
writeFileSync(path, JSON.stringify({ token }), { mode: 0o600 });
writeFileSync(
  ".build/cloud/task-funding-session.json",
  JSON.stringify({
    arn: r.tasks[0].taskArn,
    definition: def,
    mode: "funding-session",
  }),
  { mode: 0o600 },
);
console.log(
  "Started temporary authenticated funding check session setup; credentials kept private.",
);
