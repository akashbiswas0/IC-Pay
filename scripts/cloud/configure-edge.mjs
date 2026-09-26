import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const s = JSON.parse(readFileSync(".build/cloud/state.json"));
const o = JSON.parse(readFileSync(".build/cloud/outputs.json"));
const mode = process.argv[2];
if (!["stage", "live"].includes(mode)) throw Error("Expected stage or live");
const aws = (args) =>
  JSON.parse(
    execFileSync("aws", [...args, "--region", s.region, "--output", "json"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }) || "{}",
  );
const name =
  mode === "stage" ? "suica-pay-api-cloud-check" : "suica-pay-api-edge";
const roleName = "suica-pay-api-edge-role";
aws([
  "iam",
  "attach-role-policy",
  "--role-name",
  roleName,
  "--policy-arn",
  "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
]);
execFileSync(
  "zip",
  [
    "-j",
    "-q",
    `${process.cwd()}/.build/cloud/edge.zip`,
    "infra/api-edge/index.mjs",
  ],
  { stdio: "pipe" },
);
const env = {
  Variables: {
    UPSTREAM_ORIGIN: `http://${o.AlbDnsName}`,
    UPSTREAM_MODE: "internal-alb",
  },
};
const vpc = {
  SubnetIds: ["subnet-0e2f06fd11628f8f6", "subnet-09045931cd077fb33"],
  SecurityGroupIds: [o.EdgeLambdaSecurityGroupId],
};
let existing;
try {
  existing = aws([
    "lambda",
    "get-function-configuration",
    "--function-name",
    name,
  ]);
} catch {}
if (existing) {
  if (mode === "live")
    writeFileSync(
      ".build/cloud/edge-before-cutover.json",
      JSON.stringify(existing),
      { mode: 0o600 },
    );
  aws([
    "lambda",
    "update-function-code",
    "--function-name",
    name,
    "--zip-file",
    `fileb://${process.cwd()}/.build/cloud/edge.zip`,
  ]);
  execFileSync(
    "aws",
    [
      "lambda",
      "wait",
      "function-updated",
      "--function-name",
      name,
      "--region",
      s.region,
    ],
    { stdio: "pipe" },
  );
  aws([
    "lambda",
    "update-function-configuration",
    "--function-name",
    name,
    "--environment",
    JSON.stringify(env),
    "--vpc-config",
    JSON.stringify(vpc),
  ]);
} else {
  aws([
    "lambda",
    "create-function",
    "--function-name",
    name,
    "--runtime",
    "nodejs22.x",
    "--handler",
    "index.handler",
    "--role",
    `arn:aws:iam::${s.account}:role/${roleName}`,
    "--zip-file",
    `fileb://${process.cwd()}/.build/cloud/edge.zip`,
    "--timeout",
    "30",
    "--memory-size",
    "256",
    "--environment",
    JSON.stringify(env),
    "--vpc-config",
    JSON.stringify(vpc),
    "--tags",
    "Project=suica-pay",
  ]);
}
execFileSync(
  "aws",
  [
    "lambda",
    "wait",
    existing ? "function-updated" : "function-active",
    "--function-name",
    name,
    "--region",
    s.region,
  ],
  { stdio: "pipe" },
);
console.log(JSON.stringify({ function: name, mode }));
