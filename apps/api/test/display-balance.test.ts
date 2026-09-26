import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";

Object.assign(process.env, {
  DATABASE_URL: "postgresql://localhost/suica_payments_test",
  CARD_HMAC_SECRET: "balance-fallback-test-secret-32-characters",
  MULTIBAAS_URL: "https://multibaas.example",
  MULTIBAAS_API_KEY: "fixture-api-key",
  BALANCE_RPC_URL: "https://balance.example",
  CHAIN_ID: "11155111",
  TOKEN_ADDRESS: "0x" + "44".repeat(20),
  PAYMENT_ADDRESS: "0x" + "55".repeat(20),
});
const { MultiBaas, multibaas } = await import("../src/multibaas.js");
const { readWallet, allowanceSufficient } =
  await import("../src/card-wallets.js");
const { readRpcTokenBalance } = await import("../src/display-balance.js");
const abi = new Interface([
  "function balanceOf(address) view returns (uint256)",
]);
const wallet = "0x" + "11".repeat(20),
  other = "0x" + "22".repeat(20),
  token = "0x" + "44".repeat(20);
const row = { address: wallet, status: "ready" };
const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });

test("display balances stay accurate during MultiBaas throttling", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let mode = "rate",
    rpcMode = "normal",
    amount = 950n * 10n ** 18n;
  let primaryCalls = 0,
    rpcCalls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://multibaas.example/")) {
        primaryCalls++;
        if (mode === "unauthorized") return json({}, 401);
        if (String(url).endsWith("/status"))
          return json({
            result: { chainID: mode === "wrong-chain" ? 1 : 11155111 },
          });
        if (mode === "normal")
          return json({ result: { output: amount.toString() } });
        return json({ message: "request exceeds the plan’s rate limit" }, 429);
      }
      assert.equal(String(url), "https://balance.example");
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      rpcCalls++;
      const body = JSON.parse(String(init?.body));
      if (rpcMode === "offline") return json({}, 503);
      if (body.method === "eth_chainId")
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: rpcMode === "wrong-chain" ? "0x1" : "0xaa36a7",
        });
      assert.equal(body.method, "eth_call");
      assert.equal(body.params[0].to, token);
      assert.equal(body.params[1], "latest");
      const address = String(
        abi.decodeFunctionData("balanceOf", body.params[0].data)[0],
      ).toLowerCase();
      const value = address === other ? 0n : amount;
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result:
          rpcMode === "malformed"
            ? "0x"
            : abi.encodeFunctionResult("balanceOf", [value]),
      });
    },
  );
  await t.test(
    "HTTP 429 displays verified 950 MJPY through a chain-checked RPC read",
    async () => {
      const result = await readWallet(row);
      assert.equal(result?.balanceStatus, "available");
      assert.equal(result?.balance, amount.toString());
      assert.equal(result?.balanceSource, "rpc");
      assert.equal(primaryCalls, 2);
      assert.equal(rpcCalls, 2);
    },
  );
  await t.test(
    "throttled requests back off while subsequent reads remain fresh",
    async () => {
      const before = primaryCalls;
      amount -= 10n ** 18n;
      const result = await readWallet(row);
      assert.equal(result?.balance, amount.toString());
      assert.equal(primaryCalls, before);
      assert.equal(
        (await readWallet({ address: other, status: "ready" }))?.balance,
        "0",
      );
    },
  );
  await t.test(
    "concurrent reads for one wallet share work without mixing cards",
    async () => {
      const before = rpcCalls;
      const results = await Promise.all([
        readWallet(row),
        readWallet(row),
        readWallet({ address: other, status: "ready" }),
      ]);
      assert.equal(rpcCalls - before, 4);
      assert.equal(results[0]?.balance, amount.toString());
      assert.equal(results[1]?.balance, amount.toString());
      assert.equal(results[2]?.balance, "0");
    },
  );
  await t.test(
    "display fallback cannot authorize spending or replace payment balance reads",
    async () => {
      const before = rpcCalls;
      await assert.rejects(multibaas.balance(wallet), {
        code: "multibaas_rate_limited",
      });
      assert.equal(
        await allowanceSufficient(row, { total_limit: "100", spent: "0" }),
        null,
      );
      assert.equal(rpcCalls, before);
    },
  );
  await t.test(
    "wrong-chain and malformed backup responses never become balances",
    async () => {
      rpcMode = "wrong-chain";
      const before = rpcCalls;
      let result = await readWallet(row);
      assert.equal(result?.balanceStatus, "unavailable");
      assert.equal(result?.balance, null);
      assert.equal(
        rpcCalls - before,
        1,
        "Wrong chain must reject before eth_call",
      );
      rpcMode = "malformed";
      result = await readWallet(row);
      assert.equal(result?.balanceStatus, "unavailable");
      assert.equal(result?.balance, null);
      rpcMode = "offline";
      result = await readWallet(row);
      assert.equal(result?.balanceStatus, "unavailable");
      assert.equal(result?.balance, null);
      assert.equal(result?.address, wallet);
      rpcMode = "normal";
      assert.equal(
        (await readWallet(row))?.balance,
        amount.toString(),
        "Failures must not poison subsequent reads",
      );
    },
  );
  await t.test(
    "healthy MultiBaas resumes after cooldown without calling the backup",
    async () => {
      now += 61_000;
      mode = "normal";
      const before = rpcCalls;
      const result = await readWallet(row);
      assert.equal(result?.balanceSource, "multibaas");
      assert.equal(result?.balance, amount.toString());
      assert.equal(rpcCalls, before);
    },
  );
  await t.test(
    "authorization and primary chain errors are not hidden by fallback",
    async () => {
      const before = rpcCalls;
      mode = "unauthorized";
      assert.equal((await readWallet(row))?.balanceStatus, "unavailable");
      mode = "wrong-chain";
      assert.equal((await readWallet(row))?.balanceStatus, "unavailable");
      assert.equal(rpcCalls, before);
    },
  );
  await t.test(
    "RPC preserves large integer precision and rejects insecure endpoints",
    async () => {
      amount = (1n << 256n) - 1n;
      assert.equal(
        await readRpcTokenBalance(
          "https://balance.example",
          "11155111",
          token,
          wallet,
        ),
        amount.toString(),
      );
      await assert.rejects(
        readRpcTokenBalance(
          "http://balance.example",
          "11155111",
          token,
          wallet,
        ),
        { code: "invalid_balance_source" },
      );
    },
  );
});

test("MultiBaas cooldown respects Retry-After and never automatically retries a submission", async (t) => {
  let now = Date.now(),
    calls = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1
      ? json({}, 429, { "retry-after": "120" })
      : json({ result: { accepted: true } });
  });
  const api = new MultiBaas();
  await assert.rejects(
    api.request("/chains/ethereum/transactions/submit", {
      signedTx: "fixture",
    }),
    { code: "multibaas_rate_limited" },
  );
  now += 61_000;
  await assert.rejects(api.request("/chains/ethereum/status"), {
    code: "multibaas_rate_limited",
  });
  assert.equal(calls, 1);
  now += 60_000;
  assert.deepEqual(await api.request("/chains/ethereum/status"), {
    accepted: true,
  });
  assert.equal(calls, 2);
});
