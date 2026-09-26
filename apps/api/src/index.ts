import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { pool } from "./db.js";
import { buildServer } from "./server.js";
export async function runApi() {
  const app = await buildServer();
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      try {
        await app.close();
      } finally {
        await pool.end();
      }
    })();
    void closing.catch(() => {
      console.error("API shutdown failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
    await pool.end();
    throw error;
  }
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runApi();
