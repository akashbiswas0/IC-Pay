import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
const s = JSON.parse(readFileSync(".build/cloud/state.json", "utf8"));
const aws = (args) =>
  JSON.parse(
    execFileSync("aws", [...args, "--region", s.region, "--output", "json"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }) || "{}",
  );
const tag = `cloud-${Date.now()}`;
const dir = `.build/cloud/source-${tag}`;
mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const path of [
  "package.json",
  "package-lock.json",
  "Dockerfile.api",
  ".dockerignore",
  "apps/api/package.json",
  "apps/api/tsconfig.json",
  "apps/api/src",
  "apps/api/migrations",
  "apps/api/certs",
  "apps/web/package.json",
  "contracts/package.json",
  "scripts/cloud/migrate-database.mjs",
  "scripts/cloud/verify-database.mjs",
  "scripts/cloud/database-tools.mjs",
]) {
  if (!existsSync(path)) throw Error(`Missing source ${path}`);
  mkdirSync(`${dir}/${path.split("/").slice(0, -1).join("/")}`, {
    recursive: true,
  });
  cpSync(path, `${dir}/${path}`, { recursive: true });
}
const spec = {
  version: 0.2,
  phases: {
    pre_build: {
      commands: [
        `aws ecr get-login-password --region ${s.region} | docker login --username AWS --password-stdin ${s.imageRepository.split("/")[0]}`,
      ],
    },
    build: {
      commands: [
        `docker build --platform linux/amd64 -f Dockerfile.api -t ${s.imageRepository}:${tag} .`,
      ],
    },
    post_build: { commands: [`docker push ${s.imageRepository}:${tag}`] },
  },
};
writeFileSync(`${dir}/buildspec.yml`, JSON.stringify(spec));
execFileSync("zip", ["-qr", `${process.cwd()}/.build/cloud/${tag}.zip`, "."], {
  cwd: dir,
  stdio: "pipe",
});
const key = `build/${tag}.zip`;
execFileSync(
  "aws",
  [
    "s3",
    "cp",
    `.build/cloud/${tag}.zip`,
    `s3://${s.bucket}/${key}`,
    "--region",
    s.region,
    "--only-show-errors",
  ],
  { stdio: "pipe" },
);
const project = {
  name: "suica-pay-api",
  source: { type: "S3", location: `${s.bucket}/${key}` },
  artifacts: { type: "NO_ARTIFACTS" },
  environment: {
    type: "LINUX_CONTAINER",
    image: "aws/codebuild/standard:7.0",
    computeType: "BUILD_GENERAL1_SMALL",
    privilegedMode: true,
  },
  serviceRole: s.buildRoleArn,
  timeoutInMinutes: 20,
  logsConfig: {
    cloudWatchLogs: {
      status: "ENABLED",
      groupName: "/aws/codebuild/suica-pay-api",
    },
  },
  tags: [{ key: "Project", value: "suica-pay" }],
};
writeFileSync(".build/cloud/build-project.json", JSON.stringify(project), {
  mode: 0o600,
});
const current = aws([
  "codebuild",
  "batch-get-projects",
  "--names",
  project.name,
]).projects;
aws([
  "codebuild",
  current.length ? "update-project" : "create-project",
  "--cli-input-json",
  `file://${process.cwd()}/.build/cloud/build-project.json`,
]);
const build = aws([
  "codebuild",
  "start-build",
  "--project-name",
  project.name,
]).build;
s.imageUri = `${s.imageRepository}:${tag}`;
s.buildId = build.id;
writeFileSync(".build/cloud/state.json", JSON.stringify(s, null, 2), {
  mode: 0o600,
});
console.log(JSON.stringify({ buildId: s.buildId, imageUri: s.imageUri }));
