import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright-core";
const executablePath =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = new URL(
  "/qa/world-session.html?run=1",
  process.env.WORLD_QA_ORIGIN ?? "http://localhost:5173",
);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  throw new Error(
    "Run this signed-context check only on the local development server.",
  );
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  await page.goto(url.href);
  await page.waitForFunction(
    () => {
      const text = document.querySelector("#result")?.textContent;
      try {
        return ["passed", "failed"].includes(JSON.parse(text).result);
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 30000 },
  );
  const result = JSON.parse(await page.locator("#result").innerText());
  assert.equal(
    result.result,
    "passed",
    String(result.message ?? "").replace(
      /https?:\/\/[^\s"<]+/g,
      "[URL omitted]",
    ),
  );
  assert.equal(result.requestCreated, true);
  assert.equal(result.credential, "selfie");
  assert.equal(result.proofCompleted, false);
  console.log(
    JSON.stringify({
      result: "passed",
      sdk: "real IDKit browser/WASM",
      bridge: "real World request",
      credential: result.credential,
      connectorHost: result.connectorHost,
      proofCompleted: false,
    }),
  );
} finally {
  await browser?.close();
  rmSync(new URL("../qa/world-context.local.json", import.meta.url), {
    force: true,
  });
}
