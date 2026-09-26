import {
  initializeRuntimeEnvironment,
  RuntimeInitializationError,
} from "./runtime-secrets.js";
async function main() {
  const [mode = "api", ...args] = process.argv.slice(2);
  if (!["api", "worker", "migrate", "cli"].includes(mode))
    throw new RuntimeInitializationError("invalid_runtime_mode");
  await initializeRuntimeEnvironment();
  if (mode === "api") {
    const { runApi } = await import("./index.js");
    await runApi();
  } else if (mode === "worker") {
    const { runWorker } = await import("./worker.js");
    await runWorker();
  } else {
    process.argv = [
      process.argv[0]!,
      process.argv[1]!,
      ...(mode === "migrate" ? ["migrate", ...args] : args),
    ];
    await import("./cli.js");
  }
}
main().catch((error) => {
  // Provider/configuration exceptions can contain secrets; expose only our fixed initialization codes.
  console.error("Runtime initialization failed", {
    code:
      error instanceof RuntimeInitializationError
        ? error.code
        : "application_start_failed",
  });
  process.exitCode = 1;
});
