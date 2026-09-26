import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyRuntimeSecret,
  parseRuntimeSecret,
} from "../src/runtime-secrets.js";
Object.assign(process.env, {
  DATABASE_URL: "postgresql://localhost/suica_payments_test",
  DATABASE_SSL_CA_FILE: "",
  TOKEN_SYMBOL: "",
  TOKEN_NAME: "",
  TOKEN_ONCHAIN_SYMBOL: "",
  TOKEN_ADDRESS: "0x" + "11".repeat(20),
  TOKEN_DECIMALS: "18",
  CHAIN_ID: "11155111",
  MULTIBAAS_URL: "",
  MULTIBAAS_API_KEY: "",
});
const { config } = await import("../src/config.js");
const { buildServer } = await import("../src/server.js");
const { readWallet } = await import("../src/card-wallets.js");
const { pool } = await import("../src/db.js");

test("icUSD is display metadata while immutable MJPY identity and base units stay separate", async () => {
  const app = await buildServer();
  try {
    const response = await app.inject({ url: "/v1/config" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().token, {
      address: "0x" + "11".repeat(20),
      symbol: "icUSD",
      name: "IC Stablecoin",
      onchainSymbol: "MJPY",
      decimals: 18,
    });
    assert.equal(config.TOKEN_CONTRACT, "matsuristablecoin");
    const address = "0x" + "22".repeat(20);
    const wallet = await readWallet({ address, status: "ready" });
    assert.equal(wallet?.address, address);
    assert.equal(wallet?.symbol, "icUSD");
    assert.equal(wallet?.name, "IC Stablecoin");
    assert.equal(wallet?.onchainSymbol, "MJPY");
    assert.equal(wallet?.decimals, 18);
    assert.equal(wallet?.balance, null);
    assert.equal(wallet?.balanceStatus, "pending_setup");
  } finally {
    await app.close();
    await pool.end();
  }
});
test("explicit deployment branding overrides prior runtime-secret display names", () => {
  const environment = {
    TOKEN_SYMBOL: "icUSD",
    TOKEN_NAME: "IC Stablecoin",
    TOKEN_ONCHAIN_SYMBOL: "MJPY",
  };
  applyRuntimeSecret(
    parseRuntimeSecret(
      JSON.stringify({
        TOKEN_SYMBOL: "MJPY",
        TOKEN_NAME: "Matsuri",
        TOKEN_ONCHAIN_SYMBOL: "MJPY",
      }),
    ),
    environment,
  );
  assert.deepEqual(environment, {
    TOKEN_SYMBOL: "icUSD",
    TOKEN_NAME: "IC Stablecoin",
    TOKEN_ONCHAIN_SYMBOL: "MJPY",
  });
});
