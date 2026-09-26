import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
if (process.argv[2] !== "--cloud-verified")
  throw Error("Run only after successful cloud cutover");
const state = JSON.parse(readFileSync(".build/cloud/state.json"));
mkdirSync(".build/cloud/retired-launchagents", {
  recursive: true,
  mode: 0o700,
});
for (const name of ["api", "worker"]) {
  const label = `app.suicapay.local.${name}`;
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${label}`], {
      stdio: "pipe",
    });
  } catch {}
  execFileSync("launchctl", ["disable", `gui/${process.getuid()}/${label}`], {
    stdio: "pipe",
  });
  const file = `${homedir()}/Library/LaunchAgents/${label}.plist`;
  if (existsSync(file))
    renameSync(file, `.build/cloud/retired-launchagents/${label}.plist`);
}
writeFileSync(
  ".build/cloud/live.json",
  JSON.stringify(
    {
      at: new Date().toISOString(),
      region: state.region,
      stack: "suica-pay-live",
      image: state.imageUri,
      origin: "https://main.d21bivg674x6ke.amplifyapp.com",
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  "Local API/worker autostart retired; saved rollback configuration privately.",
);
