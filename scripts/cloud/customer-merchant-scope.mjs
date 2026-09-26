import { readFileSync, writeFileSync } from "node:fs";
process.umask(0o077);
const { token } = JSON.parse(
  readFileSync(".build/cloud/funding-check-session.json"),
);
const base = "https://main.d21bivg674x6ke.amplifyapp.com";
const request = async (path, body) => {
  const r = await fetch(base + path, {
    method: body ? "PUT" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const data = await r.json();
  if (!r.ok)
    throw Error(`${path}: ${r.status} ${data.error?.code || "unknown"}`);
  return data;
};
const dashboard = await request("/v1/dashboard");
if (process.argv[2] !== "apply") {
  writeFileSync(
    ".build/cloud/customer-policy-before-all.json",
    JSON.stringify(
      dashboard.cards?.map((c) => ({ id: c.id, policy: c.policy })) || [],
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify(
      dashboard.cards?.map((c) => ({
        cardId: c.id,
        enabled: c.policy?.enabled,
        merchantScope: c.policy?.merchantScope || "selected",
        perPaymentLimit: c.policy?.perPaymentLimit,
        totalLimit: c.policy?.totalLimit,
        expiresAt: c.policy?.expiresAt,
      })),
    ),
  );
} else {
  const config = await request("/v1/config");
  const before = JSON.parse(
    readFileSync(".build/cloud/customer-policy-before-all.json"),
  );
  const changed = [];
  for (const card of dashboard.cards || []) {
    const p = card.policy;
    if (!p || p.merchantScope === "all") continue;
    const captured = before.find((c) => c.id === card.id)?.policy;
    const keys = [
      "enabled",
      "perPaymentLimit",
      "totalLimit",
      "expiresAt",
      "useRewards",
      "routerAddress",
    ];
    if (
      !captured ||
      keys.some((k) => p[k] !== captured[k]) ||
      (p.merchantScope ?? "selected") !==
        (captured.merchantScope ?? "selected") ||
      JSON.stringify([...(p.merchantIds || [])].sort()) !==
        JSON.stringify([...(captured.merchantIds || [])].sort())
    )
      throw Error(
        "Permission changed since capture; preserve current user edit and inspect",
      );
    if (Date.parse(p.expiresAt) <= Date.now())
      throw Error(
        "Existing permission expired; cannot extend it automatically",
      );
    let router;
    if (p.routerAddress === config.paymentRouter?.address)
      router = config.paymentRouter.kind;
    else if (p.routerLabel === "demopayments") router = "legacy";
    else if (p.routerLabel === "rewardpayments") router = "rewards";
    else throw Error("Cannot preserve existing permission router");
    const body = {
      cardId: card.id,
      enabled: p.enabled,
      perPaymentLimit: p.perPaymentLimit,
      totalLimit: p.totalLimit,
      expiresAt: p.expiresAt,
      useRewards: p.useRewards === true,
      router,
      merchantScope: "all",
      merchantIds: [],
    };
    const result = await request("/v1/policy", body);
    if (result.merchantScope !== "all" || keys.some((k) => result[k] !== p[k]))
      throw Error("Saved permission differs from authorized scope-only change");
    changed.push(card.id);
  }
  const after = await request("/v1/dashboard");
  writeFileSync(
    ".build/cloud/customer-policy-after-all.json",
    JSON.stringify(
      after.cards?.map((c) => ({ id: c.id, policy: c.policy })) || [],
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      updatedCards: changed.length,
      allExistingPolicies: after.cards
        ?.filter((c) => c.policy)
        .every((c) => c.policy.merchantScope === "all"),
    }),
  );
}
