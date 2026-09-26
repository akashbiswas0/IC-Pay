import { workerHealthy } from "./worker-health.js";
async function main() {
  if (process.argv[2] === "worker") return workerHealthy();
  const port = process.env.PORT ?? "3001";
  if (!/^\d+$/.test(port)) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
process.exitCode = (await main()) ? 0 : 1;
