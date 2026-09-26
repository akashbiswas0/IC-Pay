import { writeFile, rename, unlink, readFile } from "node:fs/promises";
export const workerHealthFile = "/tmp/suica-pay-worker-health.json";
export async function recordWorkerProgress(path = workerHealthFile) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ pid: process.pid, at: Date.now() }),
    { mode: 0o600 },
  );
  await rename(temporary, path);
}
export async function clearWorkerProgress(path = workerHealthFile) {
  await unlink(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}
export async function workerHealthy(now = Date.now(), path = workerHealthFile) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      !Number.isFinite(value.at) ||
      now - value.at > 120000 ||
      value.at > now + 1000
    )
      return false;
    process.kill(value.pid, 0);
    return true;
  } catch {
    return false;
  }
}
