import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const mode = process.argv[2];
const s = JSON.parse(readFileSync(".build/cloud/state.json"));
const t = JSON.parse(readFileSync(`.build/cloud/task-${mode}.json`));
const aws = (args) =>
  JSON.parse(
    execFileSync("aws", [...args, "--region", s.region, "--output", "json"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }) || "{}",
  );
const r = aws([
  "ecs",
  "describe-tasks",
  "--cluster",
  "suica-pay-live",
  "--tasks",
  t.arn,
]).tasks[0];
console.log(
  JSON.stringify({
    status: r.lastStatus,
    reason: r.stoppedReason,
    containers: r.containers?.map((c) => ({
      name: c.name,
      exitCode: c.exitCode,
      reason: c.reason,
    })),
  }),
);
if (
  r.lastStatus === "STOPPED" ||
  r.containers?.every((c) => c.exitCode !== undefined)
) {
  const def = aws([
    "ecs",
    "describe-task-definition",
    "--task-definition",
    t.definition,
  ]).taskDefinition.containerDefinitions[0];
  const log = def.logConfiguration.options;
  const stream = `${log["awslogs-stream-prefix"]}/check/${t.arn.split("/").at(-1)}`;
  try {
    const events = aws([
      "logs",
      "get-log-events",
      "--log-group-name",
      log["awslogs-group"],
      "--log-stream-name",
      stream,
    ]).events;
    const text = events.map((e) => e.message).join("\n");
    writeFileSync(
      `.build/cloud/${mode}-${t.label || "check"}-logs.jsonl`,
      text + "\n",
      { mode: 0o600 },
    );
    if (mode === "restore" || mode === "verify") console.log(text);
    else
      for (const e of events) {
        try {
          console.log(JSON.stringify(JSON.parse(e.message)));
        } catch {
          console.log("Task log has non-JSON diagnostic (saved privately)");
        }
      }
  } catch {
    console.log("Task logs not yet available");
  }
  if (r.containers.some((c) => c.exitCode !== 0)) process.exitCode = 1;
}
