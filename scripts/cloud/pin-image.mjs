import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const path = ".build/cloud/state.json";
const s = JSON.parse(readFileSync(path));
const build = JSON.parse(
  execFileSync(
    "aws",
    [
      "codebuild",
      "batch-get-builds",
      "--ids",
      s.buildId,
      "--region",
      s.region,
      "--output",
      "json",
    ],
    { encoding: "utf8" },
  ),
).builds[0];
if (build.buildStatus !== "SUCCEEDED")
  throw Error(`Image build is ${build.buildStatus}`);
if (!s.imageUri.includes("@sha256:")) {
  const tag = s.imageUri.split(":").at(-1);
  const r = JSON.parse(
    execFileSync(
      "aws",
      [
        "ecr",
        "describe-images",
        "--repository-name",
        "suica-pay-api",
        "--image-ids",
        `imageTag=${tag}`,
        "--region",
        s.region,
        "--output",
        "json",
      ],
      { encoding: "utf8" },
    ),
  );
  s.imageUri = `${s.imageRepository}@${r.imageDetails[0].imageDigest}`;
  writeFileSync(path, JSON.stringify(s, null, 2), { mode: 0o600 });
}
console.log(s.imageUri);
