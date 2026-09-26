import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const s = JSON.parse(readFileSync(".build/cloud/state.json", "utf8"));
const aws = (args) =>
  JSON.parse(
    execFileSync("aws", [...args, "--region", s.region, "--output", "json"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }) || "{}",
  );
const outputs = Object.fromEntries(
  aws([
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    "suica-pay-live",
  ]).Stacks[0].Outputs.map((o) => [o.OutputKey, o.OutputValue]),
);
writeFileSync(".build/cloud/outputs.json", JSON.stringify(outputs, null, 2), {
  mode: 0o600,
});
console.log(JSON.stringify(outputs, null, 2));
