import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
process.umask(0o077);
const mode = process.argv[2] || "stage";
const sessions = JSON.parse(readFileSync(".build/cloud/check-sessions.json"));
const base =
  mode === "local"
    ? "http://127.0.0.1:3001"
    : "https://main.d21bivg674x6ke.amplifyapp.com";
async function request(path, role) {
  const headers = role
    ? { authorization: `Bearer ${sessions[role].token}` }
    : {};
  if (mode !== "stage") {
    const r = await fetch(base + path, {
      headers,
      signal: AbortSignal.timeout(30000),
    });
    return { status: r.status, body: await r.json() };
  }
  const event = {
    rawPath: path,
    rawQueryString: "",
    headers,
    requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } },
  };
  writeFileSync(".build/cloud/check-event.json", JSON.stringify(event), {
    mode: 0o600,
  });
  execFileSync(
    "aws",
    [
      "lambda",
      "invoke",
      "--function-name",
      "suica-pay-api-cloud-check",
      "--region",
      "us-east-1",
      "--payload",
      `fileb://${process.cwd()}/.build/cloud/check-event.json`,
      ".build/cloud/check-response.json",
    ],
    { stdio: "pipe" },
  );
  const r = JSON.parse(readFileSync(".build/cloud/check-response.json"));
  return {
    status: r.statusCode,
    body: JSON.parse(
      r.isBase64Encoded ? Buffer.from(r.body, "base64").toString() : r.body,
    ),
  };
}
const checks = [
  ["/health"],
  ["/v1/config"],
  ["/v1/me", "customer"],
  ["/v1/me", "merchant"],
  ["/v1/dashboard", "customer"],
  ["/v1/merchant/setup", "merchant"],
  ["/v1/merchant/rewards/campaign", "merchant"],
];
for (const [path, role] of checks) {
  const r = await request(path, role);
  if (r.status !== 200)
    throw Error(
      `API check failed ${path} status ${r.status} code ${r.body?.error?.code || "unknown"}`,
    );
  if (path === "/v1/me" && r.body.id !== sessions[role].accountId)
    throw Error("Session account mismatch");
  if (
    path === "/v1/config" &&
    (!r.body.capabilities?.world ||
      !r.body.capabilities?.payments ||
      !r.body.capabilities?.rewards)
  )
    throw Error("Missing configured capability");
  if (path === "/v1/dashboard") {
    const wallets = [
      r.body.wallet,
      ...(r.body.cards || []).map((c) => c.wallet),
    ].filter(Boolean);
    const wallet = wallets.find(
      (w) => w.address === "0x0f5b208ef5efad4c84105143e38c7e85214db8e0",
    );
    if (!wallet) throw Error("Existing customer wallet missing");
    if (wallet.balanceStatus !== "available")
      throw Error("Existing wallet balance is unavailable");
  }
  if (path === "/v1/merchant/rewards/campaign" && r.body.status !== "available")
    throw Error("Live campaign state is unavailable");
  console.log(
    JSON.stringify({ path, role: role || "public", status: r.status }),
  );
}
