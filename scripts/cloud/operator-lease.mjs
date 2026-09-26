import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OPERATOR = "0xd777e6ac65e24f046980d210356df0e6dc2bd64b";
const DURATION = 15 * 60 * 1000;
const JOURNAL = ".build/cloud/operator-lease.json";
const MARKERS = [
  "operatorLeaseAcquired",
  "operatorLeaseHeartbeat",
  "operatorLeaseReleased",
  "operatorLeaseFailed",
  "operatorLeaseLost",
];

// This program runs only inside the one-off task, with the live API's runtime/DB secrets.
// It never signs, submits transactions, or holds a PostgreSQL transaction open.
export function leaseProgram() {
  return `
let pool, client, acquired = false, stopping = false, expiry, timer;
let finish;
const stopped = new Promise(resolve => { finish = resolve; });
const emit = name => console.log(JSON.stringify({[name]:true,at:Date.now(),...(expiry?{expiresAt:expiry}:{})}));
async function stop(failed = false, lost = false) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  try {
    if (client && acquired && !lost) {
      const result = await client.query({text:'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked',values:['${OPERATOR}'],query_timeout:5000});
      if (result.rows[0]?.unlocked !== true) failed = true;
    }
  } catch { failed = true; }
  acquired = false;
  if (client) { client.release(true); client = undefined; }
  try { if (pool) await pool.end(); } catch { failed = true; }
  emit(lost ? 'operatorLeaseLost' : failed ? 'operatorLeaseFailed' : 'operatorLeaseReleased');
  process.exitCode = failed || lost ? 1 : 0;
  finish();
}
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
try {
  await (await import('./dist/runtime-secrets.js')).initializeRuntimeEnvironment();
  if (!stopping) {
    ({pool} = await import('./dist/db.js'));
    client = await pool.connect();
    if (stopping) {
      client.release(true); client = undefined;
    } else {
    client.on('error', () => { void stop(true,true); });
    const result = await client.query({text:'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',values:['${OPERATOR}'],query_timeout:5000});
    if (result.rows[0]?.locked !== true) throw new Error('lease_busy');
    if (stopping) throw new Error('lease_stopping');
    acquired = true;
    expiry = Date.now() + ${DURATION};
    emit('operatorLeaseAcquired');
    timer = setTimeout(() => { void stop(); }, ${DURATION});
    while (!stopping) {
      await Promise.race([stopped, new Promise(resolve => { const t=setTimeout(resolve,15000);t.unref(); })]);
      if (stopping) break;
      await client.query({text:'SELECT 1',query_timeout:5000});
      if (!stopping) emit('operatorLeaseHeartbeat');
    }
    }
  }
} catch { await stop(true); }
await stopped;
`;
}
export function safeMarkers(events) {
  return events.flatMap((event) => {
    try {
      const value = JSON.parse(event.message);
      const marker = MARKERS.find((name) => value[name] === true);
      if (!marker || !Number.isSafeInteger(value.at)) return [];
      return [
        {
          marker,
          at: value.at,
          ...(Number.isSafeInteger(value.expiresAt)
            ? { expiresAt: value.expiresAt }
            : {}),
        },
      ];
    } catch {
      return [];
    }
  });
}
function save(path, value, exclusive = false) {
  mkdirSync(".build/cloud", { recursive: true, mode: 0o700 });
  const text = JSON.stringify(value, null, 2) + "\n";
  if (exclusive) writeFileSync(path, text, { mode: 0o600, flag: "wx" });
  else {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, path);
  }
  chmodSync(path, 0o600);
}
async function main() {
  process.umask(0o077);
  const mode = process.argv[2];
  if (mode === "--help") {
    console.log(
      "node scripts/cloud/operator-lease.mjs start|status|release\nStart requires a subsequent status reporting held=true before deployment. Recheck status during deployment; the lease expires after 15 minutes. Release stops only the saved one-off task. A task start is not proof of acquisition.",
    );
    return;
  }
  if (
    !["start", "status", "release"].includes(mode) ||
    process.argv.length !== 3
  )
    throw new Error("invalid_mode");
  const state = JSON.parse(readFileSync(".build/cloud/state.json", "utf8"));
  const outputs = JSON.parse(readFileSync(".build/cloud/outputs.json", "utf8"));
  const aws = (args) => {
    try {
      return JSON.parse(
        execFileSync(
          "aws",
          [...args, "--region", state.region, "--output", "json"],
          {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 45000,
            maxBuffer: 8 * 1024 * 1024,
          },
        ) || "{}",
      );
    } catch {
      throw new Error("aws_operation_failed");
    }
  };
  const old = existsSync(JOURNAL)
    ? JSON.parse(readFileSync(JOURNAL, "utf8"))
    : null;
  if (
    old &&
    (old.operator !== OPERATOR ||
      old.cluster !== outputs.ClusterName ||
      old.region !== state.region)
  )
    throw new Error("lease_journal_context_mismatch");
  function describe(journal) {
    if (!journal.taskArn) return null;
    const response = aws([
      "ecs",
      "describe-tasks",
      "--cluster",
      journal.cluster,
      "--tasks",
      journal.taskArn,
    ]);
    if (response.failures?.length || response.tasks?.length !== 1)
      throw new Error("lease_task_unavailable");
    const task = response.tasks[0];
    if (
      task.taskDefinitionArn !== journal.definition ||
      task.startedBy !== journal.clientToken
    )
      throw new Error("lease_task_identity_mismatch");
    return task;
  }
  if (mode === "status") {
    if (!old) {
      console.log(JSON.stringify({ held: false, status: "not_started" }));
      return;
    }
    const task = describe(old);
    if (!task) {
      console.log(
        JSON.stringify({
          held: false,
          status: old.status,
          resumable: Boolean(old.definition),
        }),
      );
      return;
    }
    let markers = [],
      logsAvailable = false;
    try {
      const response = aws([
        "logs",
        "get-log-events",
        "--log-group-name",
        old.logGroup,
        "--log-stream-name",
        old.logStream,
        "--limit",
        "100",
      ]);
      markers = safeMarkers(response.events ?? []);
      logsAvailable = true;
    } catch {
      /* A starting task may not have a log stream yet. Never infer acquisition. */
    }
    const latest = markers.at(-1);
    const held =
      task.lastStatus === "RUNNING" &&
      task.desiredStatus === "RUNNING" &&
      !old.releaseRequestedAt &&
      logsAvailable &&
      ["operatorLeaseAcquired", "operatorLeaseHeartbeat"].includes(
        latest?.marker,
      ) &&
      Date.now() - latest.at >= 0 &&
      Date.now() - latest.at <= 45000 &&
      latest.expiresAt > Date.now();
    console.log(
      JSON.stringify({
        held,
        taskArn: old.taskArn,
        taskStatus: task.lastStatus,
        healthStatus: task.healthStatus ?? "UNKNOWN",
        logsAvailable,
        markers,
      }),
    );
    return;
  }
  if (mode === "release") {
    if (!old?.taskArn) throw new Error("no_known_lease_task_to_release");
    const task = describe(old);
    if (task.lastStatus !== "STOPPED")
      aws([
        "ecs",
        "stop-task",
        "--cluster",
        old.cluster,
        "--task",
        old.taskArn,
        "--reason",
        "Suica Pay operator deployment lease released",
      ]);
    save(JOURNAL, { ...old, releaseRequestedAt: new Date().toISOString() });
    console.log(
      JSON.stringify({
        releaseRequested: true,
        taskArn: old.taskArn,
        alreadyStopped: task.lastStatus === "STOPPED",
      }),
    );
    return;
  }
  let journal = old;
  if (journal?.taskArn) {
    const task = describe(journal);
    if (task.lastStatus !== "STOPPED")
      throw new Error("lease_task_already_active_use_status");
    save(`.build/cloud/operator-lease-${journal.clientToken}.json`, journal);
    journal = null;
  }
  if (!journal) {
    const service = aws([
      "ecs",
      "describe-services",
      "--cluster",
      outputs.ClusterName,
      "--services",
      outputs.ApiServiceName,
    ]).services?.[0];
    if (
      !service?.taskDefinition ||
      !service.networkConfiguration?.awsvpcConfiguration?.securityGroups?.includes(
        outputs.TaskSecurityGroupId,
      )
    )
      throw new Error("live_api_service_unavailable");
    const baseApiTaskDefinition = service.taskDefinition;
    const base = aws([
      "ecs",
      "describe-task-definition",
      "--task-definition",
      baseApiTaskDefinition,
    ]).taskDefinition;
    if (
      base.containerDefinitions?.length !== 1 ||
      base.networkMode !== "awsvpc"
    )
      throw new Error("unsupported_api_task_layout");
    const fields = [
      "taskRoleArn",
      "executionRoleArn",
      "networkMode",
      "containerDefinitions",
      "volumes",
      "placementConstraints",
      "requiresCompatibilities",
      "cpu",
      "memory",
      "runtimePlatform",
      "ephemeralStorage",
    ];
    const definition = Object.fromEntries(
      Object.entries(base).filter(([key]) => fields.includes(key)),
    );
    definition.family = "suica-pay-operator-lease";
    const container = definition.containerDefinitions[0];
    container.name = "operator-lease";
    delete container.healthCheck;
    delete container.portMappings;
    container.entryPoint = ["node"];
    container.command = ["--input-type=module", "-e", leaseProgram()];
    container.stopTimeout = 30;
    if (container.logConfiguration?.logDriver !== "awslogs")
      throw new Error("awslogs_required");
    const logGroup = container.logConfiguration.options["awslogs-group"];
    container.logConfiguration.options["awslogs-stream-prefix"] =
      "operator-lease";
    if (!logGroup) throw new Error("log_group_required");
    journal = {
      version: 1,
      operator: OPERATOR,
      region: state.region,
      cluster: outputs.ClusterName,
      clientToken: randomUUID(),
      baseApiTaskDefinition,
      status: "preparing",
      createdAt: new Date().toISOString(),
      logGroup,
      network: service.networkConfiguration,
    };
    // Reserve this invocation locally before any ECS mutation; retries reuse this identity.
    if (!old) save(JOURNAL, journal, true);
    else save(JOURNAL, journal);
    const definitionPath = `.build/cloud/operator-lease-definition-${journal.clientToken}.json`;
    save(definitionPath, definition);
    const registered = aws([
      "ecs",
      "register-task-definition",
      "--cli-input-json",
      `file://${resolve(definitionPath)}`,
    ]);
    journal.definition = registered.taskDefinition?.taskDefinitionArn;
    if (!journal.definition) throw new Error("lease_definition_missing");
    journal.status = "prepared";
    save(JOURNAL, journal);
  }
  if (!journal.definition)
    throw new Error("lease_preparation_ambiguous_inspect_journal");
  // ECS clientToken makes retrying a lost run-task response idempotent; never register a new task identity.
  if (Date.now() - Date.parse(journal.createdAt) > DURATION && !journal.taskArn)
    throw new Error("lease_start_window_expired_inspect_ecs");
  const result = aws([
    "ecs",
    "run-task",
    "--cluster",
    journal.cluster,
    "--task-definition",
    journal.definition,
    "--launch-type",
    "FARGATE",
    "--client-token",
    journal.clientToken,
    "--started-by",
    journal.clientToken,
    "--network-configuration",
    JSON.stringify(journal.network),
  ]);
  if (result.failures?.length || result.tasks?.length !== 1)
    throw new Error("lease_task_start_failed");
  journal.taskArn = result.tasks[0].taskArn;
  journal.logStream = `operator-lease/operator-lease/${journal.taskArn.split("/").at(-1)}`;
  journal.status = "started";
  save(JOURNAL, journal);
  console.log(
    JSON.stringify({
      leaseTaskStarted: true,
      taskArn: journal.taskArn,
      held: false,
      next: "Run status and require held=true before deployment.",
    }),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    const safe = /^[a-z_]+$/.test(error?.message ?? "")
      ? error.message
      : "operator_lease_failed";
    console.error(JSON.stringify({ operatorLeaseFailed: true, code: safe }));
    process.exitCode = 1;
  });
