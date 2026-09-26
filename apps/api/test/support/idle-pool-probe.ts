import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

/** Terminate only this probe's uniquely tagged idle test connection; never a shared/main connection. */
export async function probeIdlePool(database: string) {
  const url = new URL(database);
  assert.equal(
    url.pathname,
    "/suica_payments_test",
    "Idle-pool probe is restricted to suica_payments_test",
  );
  const application = "suica-idle-regression-" + randomUUID();
  url.searchParams.set("application_name", application);
  const control = new pg.Client({
    connectionString: database,
    connectionTimeoutMillis: 5000,
  });
  await control.connect();
  const own = (
    await control.query(
      "SELECT current_database() db,pg_backend_pid()::int pid",
    )
  ).rows[0];
  assert.equal(own.db, "suica_payments_test");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./idle-pool-child.ts", import.meta.url)),
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: url.toString(),
        IDLE_TEST_APPLICATION: application,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "",
    buffer = "",
    reconnected: any = null;
  let idleResolve!: (value: any) => void, handledResolve!: () => void;
  const idle = new Promise<any>((resolve) => {
    idleResolve = resolve;
  });
  const handled = new Promise<void>((resolve) => {
    handledResolve = resolve;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const value = JSON.parse(line);
        if (value.stage === "idle") idleResolve(value);
        if (value.stage === "reconnected") reconnected = value;
      } catch {}
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.includes("PostgreSQL idle connection error")) handledResolve();
  });
  const closed = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Idle pool regression timed out")),
      10000,
    );
  });
  try {
    const target = await Promise.race([
      idle,
      closed.then(() => {
        throw new Error(
          "Probe child exited before announcing its isolated idle connection.",
        );
      }),
      limit,
    ]);
    assert.equal(target.db, "suica_payments_test");
    assert.equal(target.application, application);
    assert(Number.isSafeInteger(target.pid) && target.pid > 0);
    assert.notEqual(target.pid, own.pid);
    const activity = (
      await control.query(
        "SELECT pid,datname,state,application_name FROM pg_stat_activity WHERE pid=$1",
        [target.pid],
      )
    ).rows[0];
    assert.equal(activity?.pid, target.pid);
    assert.equal(activity?.datname, "suica_payments_test");
    assert.equal(activity?.state, "idle");
    assert.equal(activity?.application_name, application);
    const termination = await control.query(
      "SELECT pg_terminate_backend(pid) terminated FROM pg_stat_activity WHERE pid=$1 AND datname='suica_payments_test' AND application_name=$2 AND state='idle'",
      [target.pid, application],
    );
    assert.equal(termination.rows.length, 1);
    assert.equal(termination.rows[0].terminated, true);
    const outcome = await Promise.race([
      handled.then(() => ({ handled: true })),
      closed.then((exit) => ({ handled: false, ...exit })),
      limit,
    ]);
    if (!outcome.handled)
      return {
        reconnected: false,
        unhandledError: stderr.includes("Unhandled 'error' event"),
        exitCode: "code" in outcome ? outcome.code : null,
        database: target.db,
      };
    child.stdin.end("reconnect\n");
    const exit = await Promise.race([closed, limit]);
    const safeLog =
      !/connectionParameters|password|err\.client|query:|statement:/i.test(
        stderr,
      );
    return {
      reconnected:
        reconnected?.db === "suica_payments_test" &&
        reconnected?.value === 1 &&
        reconnected?.pid !== target.pid,
      unhandledError: stderr.includes("Unhandled 'error' event"),
      exitCode: exit.code,
      database: target.db,
      safeLog,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await control.end();
  }
}
