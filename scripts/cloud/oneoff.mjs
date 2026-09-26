import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const s = JSON.parse(readFileSync(".build/cloud/state.json"));
const o = JSON.parse(readFileSync(".build/cloud/outputs.json"));
const aws = (args) =>
  JSON.parse(
    execFileSync("aws", [...args, "--region", s.region, "--output", "json"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }) || "{}",
  );
const mode = process.argv[2],
  label = process.argv[3];
if (!["restore", "verify", "kms", "migrate"].includes(mode))
  throw Error("Unknown task mode");
const base = aws([
  "ecs",
  "describe-task-definition",
  "--task-definition",
  mode === "kms" ? o.ApiTaskDefinitionArn : o.MigrationTaskDefinitionArn,
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
  "ephemeralStorage",
];
const task = Object.fromEntries(
  Object.entries(base).filter(([key]) => allowed.includes(key)),
);
task.family = "suica-pay-live-check";
const c = task.containerDefinitions[0];
c.name = "check";
c.image = s.imageUri;
delete c.healthCheck;
delete c.portMappings;
c.entryPoint = ["node"];
if (mode === "restore") {
  if (!/^[a-z0-9-]+$/.test(label || "")) throw Error("Need backup label");
  c.command = ["/app/scripts/cloud/migrate-database.mjs"];
  c.environment.push(
    ...Object.entries({
      MIGRATION_MODE: "restore",
      CONFIRM_RESTORE: "suicapay",
      RDS_MASTER_SECRET_ARN: o.DatabaseMasterSecretArn,
      MIGRATION_BUCKET: s.bucket,
      MIGRATION_KEY: `suica-pay/migration/${label}.dump`,
    }).map(([name, value]) => ({ name, value })),
  );
} else if (mode === "migrate") {
  c.command = ["dist/bootstrap.js", "migrate"];
} else if (mode === "verify")
  c.command = ["/app/scripts/cloud/verify-database.mjs"];
else if (mode === "kms") {
  const code = `const {KMSClient,GetPublicKeyCommand,SignCommand,CreateKeyCommand,CreateAliasCommand}=await import('@aws-sdk/client-kms');const {computeAddress}=await import('ethers');const k=new KMSClient({});const r=await k.send(new GetPublicKeyCommand({KeyId:'alias/suica-pay/operator'}));const der=Buffer.from(r.PublicKey);const address=computeAddress('0x'+der.subarray(-65).toString('hex')).toLowerCase();if(address!=='0xd777e6ac65e24f046980d210356df0e6dc2bd64b')throw Error('Operator mismatch');await k.send(new SignCommand({KeyId:'alias/suica-pay/operator',Message:Buffer.alloc(32,42),MessageType:'DIGEST',SigningAlgorithm:'ECDSA_SHA_256'}));console.log(JSON.stringify({operatorAddress:address,keyRead:true,sign:true}));const test=await k.send(new CreateKeyCommand({KeySpec:'ECC_SECG_P256K1',KeyUsage:'SIGN_VERIFY',Tags:[{TagKey:'Project',TagValue:'suica-pay'},{TagKey:'WalletRef',TagValue:'cloud-permission-check'}]}));console.log(JSON.stringify({temporaryKey:test.KeyMetadata.Arn}));await k.send(new CreateAliasCommand({AliasName:'alias/suica-pay/cloud-permission-check',TargetKeyId:test.KeyMetadata.Arn}));console.log(JSON.stringify({createKey:true,createAlias:true}));k.destroy();`;
  c.command = ["--input-type=module", "-e", code];
}
writeFileSync(".build/cloud/oneoff-definition.json", JSON.stringify(task), {
  mode: 0o600,
});
const def = aws([
  "ecs",
  "register-task-definition",
  "--cli-input-json",
  `file://${process.cwd()}/.build/cloud/oneoff-definition.json`,
]).taskDefinition.taskDefinitionArn;
const network = {
  awsvpcConfiguration: {
    subnets: ["subnet-0e2f06fd11628f8f6", "subnet-09045931cd077fb33"],
    securityGroups: [o.TaskSecurityGroupId],
    assignPublicIp: "ENABLED",
  },
};
const result = aws([
  "ecs",
  "run-task",
  "--cluster",
  o.ClusterName,
  "--task-definition",
  def,
  "--launch-type",
  "FARGATE",
  "--network-configuration",
  JSON.stringify(network),
]);
if (result.failures?.length) throw Error(JSON.stringify(result.failures));
const arn = result.tasks[0].taskArn;
writeFileSync(
  `.build/cloud/task-${mode}.json`,
  JSON.stringify({ arn, definition: def, mode, label }),
  { mode: 0o600 },
);
console.log(JSON.stringify({ mode, taskArn: arn }));
