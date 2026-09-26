import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
process.umask(0o077);
const path = ".build/cloud/funding-check-session.json";
const { token } = JSON.parse(readFileSync(path));
const origin = "https://main.d21bivg674x6ke.amplifyapp.com";
async function request(route, method = "GET") {
  const r = await fetch(origin + route, {
    method,
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  const data = await r.json();
  if (!r.ok)
    throw Error(
      `${route} returned ${r.status}: ${data.error?.code || "unknown"}`,
    );
  return data;
}
if (process.argv[2] === "revoke") {
  await request("/v1/logout", "POST");
  const r = await fetch(origin + "/v1/me", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.status !== 401) throw Error("Check session remains valid");
  unlinkSync(path);
  console.log("Temporary check session revoked");
} else {
  const cfg = await request("/v1/config");
  if (!cfg.capabilities.testFunding)
    throw Error("Test funding is not enabled on this API revision");
  const dashboard = await request("/v1/dashboard");
  const card =
    dashboard.cards?.find(
      (c) => c.wallet?.address === "0x0f5b208ef5efad4c84105143e38c7e85214db8e0",
    ) || dashboard.cards?.[0];
  if (!card) throw Error("No linked customer wallet");
  const status = await request(
    `/v1/test-funding?cardId=${encodeURIComponent(card.id)}`,
  );
  writeFileSync(
    ".build/cloud/funding-check-status.json",
    JSON.stringify(status, null, 2),
    { mode: 0o600 },
  );
  if (status.amount !== "1000000000000000000000" || status.symbol !== "MJPY")
    throw Error("Incorrect grant amount");
  console.log(
    JSON.stringify({
      status: status.status,
      canClaim: status.canClaim,
      claimStatus: status.claim?.status ?? null,
      txHash: status.claim?.txHash ?? null,
      errorCode: status.claim?.errorCode ?? null,
    }),
  );
  if (status.claim?.status === "confirmed") {
    const funding = await request(`/v1/cards/${status.claim.cardId}/funding`);
    const receipt = funding.transfers?.find(
      (t) =>
        t.txHash === status.claim.txHash &&
        t.amount === status.claim.amount &&
        t.from === "0x" + "00".repeat(20) &&
        t.status === "confirmed",
    );
    if (!receipt)
      throw Error("Confirmed grant missing from verified funding activity");
    const latest = await request("/v1/dashboard");
    const wallet = latest.cards?.find(
      (c) => c.id === status.claim.cardId,
    )?.wallet;
    if (wallet?.balanceStatus !== "available")
      throw Error("Updated wallet balance unavailable");
    writeFileSync(
      ".build/cloud/funding-check-confirmed.json",
      JSON.stringify({ claim: status.claim, receipt, wallet }, null, 2),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        receiptInActivity: true,
        walletBalanceAvailable: true,
        txHash: status.claim.txHash,
      }),
    );
  }
}
