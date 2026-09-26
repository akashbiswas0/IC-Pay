import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const s = JSON.parse(readFileSync(".build/cloud/state.json"));
const aws = (args) =>
  JSON.parse(
    execFileSync("aws", [...args, "--region", s.region, "--output", "json"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }) || "{}",
  );
const current = aws([
  "cloudformation",
  "describe-stacks",
  "--stack-name",
  "suica-pay-live",
]).Stacks[0];
const overrides = { ImageUri: s.imageUri };
for (const pair of process.argv.slice(2)) {
  const [key, value] = pair.split("=");
  const tokenBranding = ["TokenDisplayName", "TokenDisplaySymbol", "TokenOnchainSymbol"].includes(key) && /^[A-Za-z][A-Za-z0-9 ]{0,39}$/.test(value);
  const service =
    ["ApiDesiredCount", "WorkerDesiredCount"].includes(key) &&
    ["0", "1", "2"].includes(value);
  const funding =
    key === "TestFundingEnabled" && ["true", "false"].includes(value);
  const limit =
    key === "TestFundingDailyLimit" &&
    /^\d+$/.test(value) &&
    Number(value) >= 1 &&
    Number(value) <= 1000;
  const loyaltyAddress = key === "LoyaltyPaymentAddress" && /^0x[0-9a-f]{40}$/.test(value);
  const loyaltyLabel = key === "LoyaltyPaymentContract" && /^[a-z][a-z0-9]*$/.test(value);
  const collectibleAddress = key === "CollectiblePaymentAddress" && /^0x[0-9a-f]{40}$/.test(value);
  const collectibleLabel = key === "CollectiblePaymentContract" && /^[a-z][a-z0-9]*$/.test(value);
  const artwork = key === "CollectibleArtworkBaseUrl" && /^https:\/\/main\.d21bivg674x6ke\.amplifyapp\.com\/nft-art\/[a-f0-9]{20}\/$/.test(value);
  if (!tokenBranding && !service && !funding && !limit && !loyaltyAddress && !loyaltyLabel && !collectibleAddress && !collectibleLabel && !artwork)
    throw Error("Invalid deployment parameter");
  overrides[key] = value;
}
const parameters = current.Parameters.map((p) =>
  overrides[p.ParameterKey] !== undefined
    ? {
        ParameterKey: p.ParameterKey,
        ParameterValue: overrides[p.ParameterKey],
      }
    : { ParameterKey: p.ParameterKey, UsePreviousValue: true },
);
for (const [ParameterKey, ParameterValue] of Object.entries(overrides)) {
  if (!parameters.some((p) => p.ParameterKey === ParameterKey))
    parameters.push({ ParameterKey, ParameterValue });
}
writeFileSync(
  ".build/cloud/update-parameters.json",
  JSON.stringify(parameters),
  { mode: 0o600 },
);
console.log(
  aws([
    "cloudformation",
    "update-stack",
    "--stack-name",
    "suica-pay-live",
    "--template-body",
    `file://${process.cwd()}/infra/cloud/stack.yaml`,
    "--parameters",
    `file://${process.cwd()}/.build/cloud/update-parameters.json`,
    "--capabilities",
    "CAPABILITY_IAM",
  ]),
);
