import { readFile, mkdir, writeFile } from "node:fs/promises";
const names = [
  "MatsuriStablecoin",
  "DemoPayments",
  "RewardPayments",
  "CollectibleRewards",
  "LoyaltyPoints",
];
await mkdir(new URL("../abi/", import.meta.url), { recursive: true });
for (const name of names) {
  const artifact = JSON.parse(
    await readFile(
      new URL(`../artifacts/src/${name}.sol/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
  await writeFile(
    new URL(`../abi/${name}.json`, import.meta.url),
    `${JSON.stringify(artifact.abi, null, 2)}\n`,
  );
}
