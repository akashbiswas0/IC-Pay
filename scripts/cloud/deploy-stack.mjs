import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const s = JSON.parse(readFileSync(".build/cloud/state.json", "utf8"));
const params = {
  ImageUri: s.imageUri || `${s.imageRepository}:pending`,
  RuntimeSecretArn: s.runtimeArn,
  DatabaseAppSecretArn: s.dbArn,
  VpcId: "vpc-068092c62ad659401",
  PublicSubnetIds: "subnet-0e2f06fd11628f8f6,subnet-09045931cd077fb33",
  ApiDesiredCount: "0",
  WorkerDesiredCount: "0",
  DatabaseName: "suicapay",
  DatabaseInstanceClass: "db.t4g.micro",
  TaskCpu: "256",
  TaskMemory: "512",
  MigrationBucketName: s.bucket,
  MigrationObjectPrefix: "suica-pay/migration/",
};
writeFileSync(
  ".build/cloud/stack-parameters.json",
  JSON.stringify(
    Object.entries(params).map(([ParameterKey, ParameterValue]) => ({
      ParameterKey,
      ParameterValue,
    })),
  ),
  { mode: 0o600 },
);
const result = execFileSync(
  "aws",
  [
    "cloudformation",
    "create-stack",
    "--stack-name",
    "suica-pay-live",
    "--template-body",
    `file://${process.cwd()}/infra/cloud/stack.yaml`,
    "--parameters",
    `file://${process.cwd()}/.build/cloud/stack-parameters.json`,
    "--capabilities",
    "CAPABILITY_IAM",
    "--region",
    s.region,
    "--tags",
    "Key=Project,Value=suica-pay",
    "--output",
    "json",
  ],
  { encoding: "utf8" },
);
console.log(result);
