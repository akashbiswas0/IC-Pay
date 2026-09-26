import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
const region = "us-east-1";
const aws = (args, input) =>
  JSON.parse(
    execFileSync("aws", [...args, "--region", region, "--output", "json"], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }) || "{}",
  );
const exists = (args) => {
  try {
    return aws(args);
  } catch (e) {
    if (
      /ResourceNotFound|does not exist|NotFound|NoSuchEntity|NoSuchBucket/.test(
        e.stderr?.toString() || "",
      )
    )
      return null;
    throw e;
  }
};
const account = aws(["sts", "get-caller-identity"]).Account;
mkdirSync(".build/cloud", { recursive: true, mode: 0o700 });
const env = dotenv.parse(readFileSync(".env"));
const allowed = [
  ...readFileSync("apps/api/src/config.ts", "utf8").matchAll(
    /^    ([A-Z][A-Z0-9_]+):/gm,
  ),
].map((m) => m[1]);
const excluded = new Set([
  "DATABASE_URL",
  "DATABASE_SSL_CA_FILE",
  "HOST",
  "PORT",
  "TRUST_PROXY_HOPS",
]);
const runtime = Object.fromEntries(
  allowed.filter((k) => !excluded.has(k) && env[k]).map((k) => [k, env[k]]),
);
runtime.AWS_REGION = region;
function secret(name, value) {
  let s = exists(["secretsmanager", "describe-secret", "--secret-id", name]);
  if (s) return s.ARN;
  const f = `.build/cloud/${name.split("/").at(-1)}.json`;
  writeFileSync(f, JSON.stringify(value), { mode: 0o600 });
  s = aws([
    "secretsmanager",
    "create-secret",
    "--name",
    name,
    "--secret-string",
    `file://${process.cwd()}/${f}`,
    "--tags",
    "Key=Project,Value=suica-pay",
  ]);
  return s.ARN;
}
const runtimeArn = secret("suica-pay/cloud/runtime", runtime);
const dbArn = secret("suica-pay/cloud/database-app", {
  username: "suica_app",
  password: randomBytes(36).toString("base64url"),
});
const repo =
  exists([
    "ecr",
    "describe-repositories",
    "--repository-names",
    "suica-pay-api",
  ])?.repositories?.[0] ||
  aws([
    "ecr",
    "create-repository",
    "--repository-name",
    "suica-pay-api",
    "--image-scanning-configuration",
    "scanOnPush=true",
    "--image-tag-mutability",
    "IMMUTABLE",
    "--tags",
    "Key=Project,Value=suica-pay",
  ]).repository;
const bucket = `suica-pay-cloud-${account}-${region}`;
try {
  execFileSync("aws", ["s3api", "head-bucket", "--bucket", bucket], {
    stdio: "pipe",
  });
} catch {
  aws(["s3api", "create-bucket", "--bucket", bucket]);
}
aws([
  "s3api",
  "put-public-access-block",
  "--bucket",
  bucket,
  "--public-access-block-configuration",
  JSON.stringify({
    BlockPublicAcls: true,
    IgnorePublicAcls: true,
    BlockPublicPolicy: true,
    RestrictPublicBuckets: true,
  }),
]);
aws([
  "s3api",
  "put-bucket-encryption",
  "--bucket",
  bucket,
  "--server-side-encryption-configuration",
  JSON.stringify({
    Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
  }),
]);
aws([
  "s3api",
  "put-bucket-versioning",
  "--bucket",
  bucket,
  "--versioning-configuration",
  "Status=Enabled",
]);
aws([
  "s3api",
  "put-bucket-policy",
  "--bucket",
  bucket,
  "--policy",
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "RequireTLS",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      },
    ],
  }),
]);
const trust = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "codebuild.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
};
const role =
  exists(["iam", "get-role", "--role-name", "suica-pay-cloud-build"])?.Role ||
  aws([
    "iam",
    "create-role",
    "--role-name",
    "suica-pay-cloud-build",
    "--assume-role-policy-document",
    JSON.stringify(trust),
    "--tags",
    "Key=Project,Value=suica-pay",
  ]).Role;
const policy = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ],
      Resource: `arn:aws:logs:${region}:${account}:log-group:/aws/codebuild/suica-pay-api*`,
    },
    {
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:GetObjectVersion"],
      Resource: `arn:aws:s3:::${bucket}/build/*`,
    },
    { Effect: "Allow", Action: "ecr:GetAuthorizationToken", Resource: "*" },
    {
      Effect: "Allow",
      Action: [
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
      ],
      Resource: repo.repositoryArn,
    },
  ],
};
aws([
  "iam",
  "put-role-policy",
  "--role-name",
  role.RoleName,
  "--policy-name",
  "BuildImage",
  "--policy-document",
  JSON.stringify(policy),
]);
const state = {
  region,
  account,
  runtimeArn,
  dbArn,
  imageRepository: repo.repositoryUri,
  bucket,
  buildRoleArn: role.Arn,
};
writeFileSync(".build/cloud/state.json", JSON.stringify(state, null, 2), {
  mode: 0o600,
});
console.log(JSON.stringify(state, null, 2));
