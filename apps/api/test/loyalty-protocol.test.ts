import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { Interface } from "ethers";
import {
  limitedPoints,
  loyaltyABI,
  pointUnit,
} from "../src/loyalty-protocol.js";
import { canonicalScan, scanSchema, verifyScan } from "../src/protocol.js";
Object.assign(process.env, {
  LOYALTY_PAYMENT_ADDRESS: "0x" + "88".repeat(20),
  TOKEN_DECIMALS: "18",
  CHAIN_ID: "11155111",
});
const { validateLoyaltyReceipt, historyFromLoyaltyLog } =
  await import("../src/loyalty.js");
const { refundReceiptMatches } = await import("../src/loyalty-refunds.js");
const { merchantBytes32 } = await import("../src/multibaas.js");
const { matchesJobTransaction } = await import("../src/reconciliation.js");
const unit = pointUnit(18),
  router = process.env.LOYALTY_PAYMENT_ADDRESS!,
  mid = randomUUID(),
  payer = "0x" + "11".repeat(20),
  recipient = "0x" + "22".repeat(20),
  token = "0x" + "33".repeat(20),
  invoice = "0x" + "44".repeat(32),
  tx = "0x" + "55".repeat(32);
const job = {
  kind: "payment",
  invoice_id: invoice,
  merchant_id: mid,
  address: payer,
  recipient,
  expected_router: router,
  expected_chain: "11155111",
  expected_token: token,
  nonce: "1",
  gross_amount: String(3n * unit),
  amount: String(unit),
  points_redeemed: "2",
  discount_amount: String(2n * unit),
  expires_at: new Date(Date.now() + 60000),
};
const state = {
  merchantId: merchantBytes32(mid),
  recipient,
  grossAmount: String(3n * unit),
  netAmount: String(unit),
  redeemedPoints: "2",
  earnedUnits: String(unit / 20n),
  debtRepaid: "0",
  earnedExpiresAt: "1900000000",
  campaignVersion: "1",
  earnBps: "500",
  maxEarnPoints: "50",
  createdAt: "1800000000",
  refunded: false,
};
const event = (name: string, args: unknown[], index = 0) => ({
  ...loyaltyABI.encodeEventLog(loyaltyABI.getEvent(name)!, args),
  address: router,
  logIndex: "0x" + index.toString(16),
});
const redeemed = () =>
  event("PointsRedeemed", [invoice, merchantBytes32(mid), payer, 2, 2n * unit]);
const earned = () =>
  event(
    "PointsEarned",
    [invoice, merchantBytes32(mid), payer, unit, unit / 20n, 0, 1900000000, 1],
    1,
  );
test("point quote caps are whole units and automatic zero never fabricates a discount", () => {
  assert.equal(
    limitedPoints("5", String((25n * unit) / 10n), unit, null, null),
    2n,
  );
  assert.equal(limitedPoints("5", String(10n * unit), unit, "4", "3"), 3n);
  for (const args of [
    ["0", String(unit), null, null],
    ["5", String(unit), "0", null],
    ["5", String(unit), null, "0"],
    ["5", String(unit / 2n), null, null],
  ] as const)
    assert.equal(limitedPoints(args[0], args[1], unit, args[2], args[3]), 0n);
});
test("v3 real P256 signature binds nullable cap and remains incompatible with changed cap or router", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = keys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const payload = scanSchema.parse({
    version: 3,
    terminalId: randomUUID(),
    invoiceId: invoice,
    challenge: "a".repeat(43),
    cardId: "0102030405060708",
    chainId: "11155111",
    token,
    amount: String(unit),
    expiresAt: job.expires_at.toISOString(),
    routerAddress: router,
    useReward: true,
    maxPoints: null,
  });
  const signature = sign(
    "sha256",
    canonicalScan(payload),
    keys.privateKey,
  ).toString("base64");
  assert(verifyScan(payload, signature, spki));
  assert.equal(canonicalScan(payload).toString().split("\n").at(-1), "auto");
  assert(!verifyScan({ ...payload, maxPoints: "0" }, signature, spki));
  assert(!verifyScan({ ...payload, routerAddress: token }, signature, spki));
  const { maxPoints, ...missing } = payload;
  assert.equal(scanSchema.safeParse(missing).success, false);
});
test("exact signed payWithPoints calldata cannot silently consume less points or charge more", () => {
  const input = loyaltyABI.encodeFunctionData("payWithPoints", [
    invoice,
    merchantBytes32(mid),
    job.gross_amount,
    Math.floor(job.expires_at.getTime() / 1000),
    2,
  ]);
  const chainTx = {
    to: router,
    input,
    value: "0",
    nonce: "1",
    chainId: "11155111",
  };
  assert(
    matchesJobTransaction(
      { ...job, merchant_key: merchantBytes32(mid) },
      chainTx,
      payer,
    ),
  );
  assert(
    !matchesJobTransaction(
      { ...job, merchant_key: merchantBytes32(mid), points_redeemed: "1" },
      chainTx,
      payer,
    ),
  );
});
test("receipt requires exact earned and redeemed events including missing and duplicate detection", () => {
  assert.equal(
    validateLoyaltyReceipt([redeemed(), earned()], job, state).length,
    2,
  );
  for (const logs of [
    [],
    [redeemed()],
    [earned()],
    [redeemed(), redeemed(), earned()],
    [redeemed(), earned(), earned()],
    [{ ...redeemed(), address: token }, earned()],
    [{ ...redeemed(), removed: true }, earned()],
  ])
    assert.throws(() => validateLoyaltyReceipt(logs, job, state));
  for (const changed of [
    { amount: "0" },
    { points_redeemed: "1" },
    { address: recipient },
    { invoice_id: tx },
    { merchant_id: randomUUID() },
  ])
    assert.throws(() =>
      validateLoyaltyReceipt(
        [redeemed(), earned()],
        { ...job, ...changed },
        state,
      ),
    );
  assert.throws(() =>
    validateLoyaltyReceipt([redeemed(), earned()], job, {
      ...state,
      earnedUnits: "1",
    }),
  );
});
test("fully covered and disabled-earning payments confirm with no invented earned event", () => {
  const full = { ...job, gross_amount: String(2n * unit), amount: "0" };
  const fullState = {
    ...state,
    grossAmount: String(2n * unit),
    netAmount: "0",
    earnedUnits: "0",
    debtRepaid: "0",
    earnBps: "0",
    maxEarnPoints: "0",
    campaignVersion: "0",
  };
  assert.equal(validateLoyaltyReceipt([redeemed()], full, fullState).length, 1);
  const noPoints = {
    ...job,
    points_redeemed: "0",
    gross_amount: String(unit),
    discount_amount: "0",
  };
  const noEarning = {
    ...state,
    grossAmount: String(unit),
    redeemedPoints: "0",
    earnedUnits: "0",
    earnBps: "0",
    maxEarnPoints: "0",
    campaignVersion: "0",
  };
  assert.equal(validateLoyaltyReceipt([], noPoints, noEarning).length, 0);
});
test("fractional history preserves exact reward units and refund/reversal IDs remain distinct", () => {
  const wallet = { address: payer, card_id: randomUUID() },
    shops = new Map([[merchantBytes32(mid), { id: mid, name: "Shop" }]]);
  const row = historyFromLoyaltyLog(
    earned(),
    wallet,
    shops,
    tx,
    "2026-09-27T00:00:00.000Z",
    unit,
  )[0]!;
  assert.equal(row.points, "0");
  assert.equal(row.pointsUnits, String(unit / 20n));
  assert.equal(row.tokenAmount, String(unit));
  assert.equal(row.id.split(":").at(-1), "1");
  const refund = event(
    "PaymentRefunded",
    [
      invoice,
      merchantBytes32(mid),
      payer,
      recipient,
      token,
      unit,
      2n * unit,
      unit / 20n,
      0,
    ],
    2,
  );
  const history = historyFromLoyaltyLog(
    refund,
    wallet,
    shops,
    tx,
    "2026-09-27T00:00:00.000Z",
    unit,
  );
  assert.equal(history.length, 2);
  assert.notEqual(history[0]!.id, history[1]!.id);
  assert.equal(history[1]!.pointsUnits, String(unit / 20n));
  assert.equal(
    historyFromLoyaltyLog(
      { ...earned(), removed: true },
      wallet,
      shops,
      tx,
      "2026-09-27T00:00:00.000Z",
      unit,
    ).length,
    0,
  );
  assert.throws(() =>
    historyFromLoyaltyLog(
      { ...earned(), logIndex: "bad" },
      wallet,
      shops,
      tx,
      "2026-09-27T00:00:00.000Z",
      unit,
    ),
  );
});
test("refund requires actual token return, exact original recipient/payer and bounded contract point adjustment", () => {
  const row = {
    invoice_id: invoice,
    merchant_id: mid,
    payer,
    recipient,
    token_address: token,
    router_address: router,
    amount: String(unit),
  };
  const refund = event("PaymentRefunded", [
    invoice,
    merchantBytes32(mid),
    payer,
    recipient,
    token,
    unit,
    2n * unit,
    unit / 20n,
    0,
  ]);
  const erc20 = new Interface([
    "event Transfer(address indexed from,address indexed to,uint256 value)",
  ]);
  const returned = {
    ...erc20.encodeEventLog(erc20.getEvent("Transfer")!, [
      recipient,
      payer,
      unit,
    ]),
    address: token,
    logIndex: "0x1",
  };
  const confirmed = { timestamp: 1800000001, debtUnits: "0" },
    refunded = { ...state, refunded: true };
  assert(refundReceiptMatches([refund, returned], row, refunded, confirmed));
  for (const logs of [
    [refund],
    [returned],
    [refund, { ...returned, address: router }],
    [refund, returned, returned],
    [{ ...refund, removed: true }, returned],
  ])
    assert.equal(refundReceiptMatches(logs, row, refunded, confirmed), false);
  assert.equal(
    refundReceiptMatches([refund, returned], row, state, confirmed),
    false,
  );
  assert.equal(
    refundReceiptMatches([refund, returned], row, refunded, {
      ...confirmed,
      timestamp: 1900000001,
    }),
    false,
  );
});

test("a failed nonce is terminal only with its fresh canonical reverted receipt and confirmation depth", async () => {
  const { acceptedOperatorReceiptMatches } = await import("../src/operator.js");
  const row = {
    status: "failed",
    block_number: "100",
    block_hash: "0x" + "aa".repeat(32),
    tx_hash: tx,
  };
  const receipt = {
    transactionHash: tx,
    blockNumber: "0x64",
    blockHash: row.block_hash,
    status: "0x0",
  };
  assert(
    acceptedOperatorReceiptMatches(
      row,
      receipt,
      { hash: row.block_hash },
      { number: 102 },
      3,
    ),
  );
  for (const value of [
    null,
    { ...receipt, status: "0x1" },
    { ...receipt, blockHash: tx },
    { ...receipt, blockNumber: "0x63" },
    { ...receipt, transactionHash: invoice },
  ])
    assert.equal(
      acceptedOperatorReceiptMatches(
        row,
        value,
        { hash: row.block_hash },
        { number: 102 },
        3,
      ),
      false,
    );
  assert.equal(
    acceptedOperatorReceiptMatches(
      row,
      receipt,
      { hash: tx },
      { number: 102 },
      3,
    ),
    false,
  );
  assert.equal(
    acceptedOperatorReceiptMatches(
      row,
      receipt,
      { hash: row.block_hash },
      { number: 101 },
      3,
    ),
    false,
  );
  assert(
    acceptedOperatorReceiptMatches(
      { ...row, status: "confirmed" },
      { ...receipt, status: "0x1" },
      { hash: row.block_hash },
      { number: 102 },
      3,
    ),
  );
});
