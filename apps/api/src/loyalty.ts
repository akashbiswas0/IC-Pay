import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { config, hasLoyalty } from "./config.js";
import { pool, transaction } from "./db.js";
import { authenticate, customer, merchant } from "./auth.js";
import { resolveCard } from "./card-wallets.js";
import { AppError } from "./errors.js";
import { multibaas, merchantBytes32, decodeTokenBalance } from "./multibaas.js";
import { paymentRouter, routerSnapshot } from "./payment-router.js";
import {
  readRewardAtBlock,
  type ConfirmedRewardAnchor,
} from "./reward-read.js";
import { confirmedRewardBlock, tuple } from "./rewards.js";
import { amountSchema } from "./protocol.js";
import {
  loyaltyABI,
  wholePointsSchema,
  pointUnit,
  limitedPoints,
} from "./loyalty-protocol.js";
const uint = (v: unknown) => decodeTokenBalance(v);
const iso = (s: unknown) => {
  const n = Number(uint(s));
  if (!Number.isSafeInteger(n)) throw new Error("Invalid chain timestamp");
  return new Date(n * 1000).toISOString();
};
const explorer = (tx: string) =>
  config.EXPLORER_URL
    ? `${config.EXPLORER_URL.replace(/\/$/, "")}/tx/${tx}`
    : null;
export async function readLoyalty(
  method: Parameters<typeof readRewardAtBlock>[2],
  args: unknown[],
  anchor: ConfirmedRewardAnchor,
  address = config.LOYALTY_PAYMENT_ADDRESS!,
  label = config.LOYALTY_PAYMENT_CONTRACT,
) {
  return (await readRewardAtBlock(address, label, method, args, anchor)).output;
}
export async function validatePointUnit(anchor: ConfirmedRewardAnchor) {
  const output = await readLoyalty("pointUnit", [], anchor);
  const unit = BigInt(uint(Array.isArray(output) ? output[0] : output));
  if (unit !== pointUnit(config.TOKEN_DECIMALS))
    throw new AppError(
      "point_unit_mismatch",
      "The configured token unit differs from the points contract.",
      503,
    );
  return unit;
}
export async function readLoyaltyProgram(
  mid: string,
  anchor: ConfirmedRewardAnchor,
) {
  const [
    enabled,
    minPurchase,
    earnBps,
    maxEarnPoints,
    validitySeconds,
    version,
  ] = tuple(await readLoyalty("campaigns", [merchantBytes32(mid)], anchor), [
    "enabled",
    "minPurchase",
    "earnBps",
    "maxEarnPoints",
    "validitySeconds",
    "version",
  ]);
  if (typeof enabled !== "boolean") throw new Error("Invalid program state");
  return BigInt(uint(version)) === 0n
    ? null
    : {
        enabled,
        minPurchase: uint(minPurchase),
        earnBps: Number(uint(earnBps)),
        maxPointsPerPurchase: uint(maxEarnPoints),
        validitySeconds: Number(uint(validitySeconds)),
        version: Number(uint(version)),
      };
}
export async function reservedPoints(
  walletId: string,
  merchantId: string,
  router: string,
  db: Pick<PoolClient, "query"> = pool,
  exceptJob?: string,
) {
  return BigInt(
    (
      await db.query(
        "SELECT COALESCE(sum(r.points),0)::text points FROM loyalty_reservations r JOIN payment_jobs j ON j.id=r.job_id WHERE r.wallet_id=$1 AND r.merchant_id=$2 AND r.router_address=$3 AND r.chain_id=$4 AND ($5::uuid IS NULL OR r.job_id<>$5) AND (r.released_at IS NULL OR j.status IN ('submitting','pending','reconciling'))",
        [walletId, merchantId, router, config.CHAIN_ID, exceptJob ?? null],
      )
    ).rows[0].points,
  );
}
export async function choosePoints(
  db: PoolClient,
  wallet: any,
  merchantId: string,
  gross: string,
  merchantCap: string | null,
  customerCap: string | null,
) {
  if (!hasLoyalty)
    throw new AppError(
      "loyalty_unconfigured",
      "Merchant points are not configured.",
      503,
    );
  const router = paymentRouter("loyalty"),
    anchor = await confirmedRewardBlock(),
    unit = await validatePointUnit(anchor);
  const [available] = tuple(
    await readLoyalty(
      "pointsBalance",
      [wallet.address, merchantBytes32(merchantId)],
      anchor,
    ),
    ["availablePoints", "fractionalUnits", "debtUnits", "nextExpiryAt"],
  );
  const reserved = await reservedPoints(
    wallet.id,
    merchantId,
    router.address,
    db,
  );
  const remaining = BigInt(uint(available)) - reserved;
  const chosen = limitedPoints(
    (remaining > 0n ? remaining : 0n).toString(),
    gross,
    unit,
    merchantCap,
    customerCap,
  );
  const quote = await multibaas.call(
    router.address,
    router.label,
    "quotePoints",
    [wallet.address, merchantBytes32(merchantId), gross, chosen.toString()],
  );
  const [used, discount, net] = tuple(quote.output, [
    "pointsUsed",
    "discount",
    "netAmount",
  ]);
  if (
    BigInt(uint(used)) !== chosen ||
    BigInt(uint(discount)) !== chosen * unit ||
    BigInt(uint(net)) + chosen * unit !== BigInt(gross)
  )
    throw new AppError(
      "points_quote_changed",
      "The points quote changed. Request another invoice.",
      409,
    );
  return {
    rewardId: null,
    pointsRedeemed: chosen.toString(),
    discountAmount: uint(discount),
    netAmount: uint(net),
  };
}
export async function reservePoints(
  db: PoolClient,
  walletId: string,
  merchantId: string,
  jobId: string,
  points: string,
  router: string,
) {
  if (BigInt(points) <= 0n) throw new Error("Cannot reserve zero points");
  await db.query(
    "INSERT INTO loyalty_reservations(id,chain_id,router_address,wallet_id,merchant_id,job_id,points)VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      randomUUID(),
      config.CHAIN_ID,
      router,
      walletId,
      merchantId,
      jobId,
      points,
    ],
  );
}
export async function consumePoints(db: PoolClient, job: any) {
  if (BigInt(job.points_redeemed ?? 0) > 0n)
    await db.query(
      "UPDATE loyalty_reservations SET consumed_at=now(),released_at=now() WHERE job_id=$1 AND released_at IS NULL",
      [job.id],
    );
}
export const loyaltyProgramSchema = z.object({
  enabled: z.boolean(),
  minPurchase: amountSchema,
  earnBps: z.number().int().min(1).max(10000),
  maxPointsPerPurchase: amountSchema,
  validitySeconds: z.number().int().min(60).max(31536000),
});
async function enumerate(
  method: "walletMerchantIds" | "merchantWallets",
  key: string,
  anchor: ConfirmedRewardAnchor,
) {
  const values: string[] = [];
  for (let offset = 0; offset < 250; offset += 50) {
    const output = await readLoyalty(
      method,
      [key, String(offset), "50"],
      anchor,
    );
    const [page, total] = tuple(output, [
      method === "walletMerchantIds" ? "merchantIds" : "wallets",
      "total",
    ]);
    if (!Array.isArray(page)) throw new Error("Invalid ledger index");
    values.push(...page.map(String));
    if (BigInt(values.length) >= BigInt(uint(total))) return values;
  }
  throw new AppError(
    "loyalty_history_limit",
    "This loyalty ledger requires additional pagination.",
    503,
  );
}
async function walletBalances(
  wallet: any,
  anchor: ConfirmedRewardAnchor,
  unit: bigint,
) {
  const ids = await enumerate("walletMerchantIds", wallet.address, anchor);
  const shops = new Map(
    (await pool.query("SELECT id,name,enabled FROM merchants")).rows.map(
      (m) => [merchantBytes32(m.id), m],
    ),
  );
  const rows = [];
  for (const key of ids) {
    const shop = shops.get(key);
    const [available, fraction, debt, expiry] = tuple(
      await readLoyalty("pointsBalance", [wallet.address, key], anchor),
      ["availablePoints", "fractionalUnits", "debtUnits", "nextExpiryAt"],
    );
    const held = shop
      ? await reservedPoints(
          wallet.id,
          shop.id,
          config.LOYALTY_PAYMENT_ADDRESS!,
        )
      : 0n;
    const spendable = BigInt(uint(available)) - held;
    rows.push({
      id: `${config.CHAIN_ID}:${config.LOYALTY_PAYMENT_ADDRESS}:${wallet.address}:${key}`,
      cardId: wallet.card_id,
      walletAddress: wallet.address,
      merchantId: shop?.id ?? key,
      merchantName: shop?.name ?? "Unlisted merchant",
      merchantEnabled: shop?.enabled ?? false,
      availablePoints: uint(available),
      reservedPoints: held.toString(),
      spendablePoints: (spendable > 0n ? spendable : 0n).toString(),
      fractionalUnits: uint(fraction),
      debtUnits: uint(debt),
      fractionNumerator: uint(fraction),
      fractionDenominator: unit.toString(),
      expiresAt: BigInt(uint(expiry)) > 0n ? iso(expiry) : null,
      program: shop ? await readLoyaltyProgram(shop.id, anchor) : null,
    });
  }
  return rows;
}
export function historyFromLoyaltyLog(
  log: any,
  wallet: any,
  shops: Map<string, any>,
  txHash: string,
  createdAt: string,
  unit: bigint,
) {
  if (
    log.removed ||
    String(log.address).toLowerCase() !== config.LOYALTY_PAYMENT_ADDRESS
  )
    return [];
  let event;
  try {
    event = loyaltyABI.parseLog(log);
  } catch {
    return [];
  }
  if (!event || String(event.args.payer).toLowerCase() !== wallet.address)
    return [];
  const shop = shops.get(String(event.args.merchantId));
  const base = {
    id: `${config.CHAIN_ID}:${String(log.address).toLowerCase()}:${txHash.toLowerCase()}:${BigInt(log.logIndex).toString()}`,
    cardId: wallet.card_id,
    walletAddress: wallet.address,
    merchantId: shop?.id ?? String(event.args.merchantId),
    merchantName: shop?.name ?? "Unlisted merchant",
    invoiceId:
      event.name === "PointsExpired" ? null : String(event.args.invoiceId),
    createdAt,
    txHash,
    explorerUrl: explorer(txHash),
  };
  const row = (
    kind: string,
    units: bigint,
    tokenAmount: string | null,
    extra = {},
  ) => ({
    ...base,
    kind,
    points: (units / unit).toString(),
    pointsUnits: units.toString(),
    tokenAmount,
    ...extra,
  });
  if (event.name === "PointsEarned")
    return [
      row("earned", event.args.earnedUnits, String(event.args.tokenAmount), {
        debtRepaidUnits: String(event.args.debtRepaid),
      }),
    ];
  if (event.name === "PointsRedeemed")
    return [
      row("redeemed", event.args.points * unit, String(event.args.discount)),
    ];
  if (event.name === "PointsExpired")
    return [row("expired", event.args.expiredUnits, null)];
  if (event.name === "PaymentRefunded")
    return [
      row(
        "refunded",
        event.args.pointsRestoredUnits,
        String(event.args.amount),
        { id: base.id + ":restored" },
      ),
      ...(BigInt(event.args.earnedReversedUnits) > 0n
        ? [
            row("reversed", event.args.earnedReversedUnits, null, {
              id: base.id + ":reversed",
            }),
          ]
        : []),
    ];
  return [];
}
async function walletHistory(
  wallet: any,
  anchor: ConfirmedRewardAnchor,
  unit: bigint,
  cache: { receipts: Map<string, any>; blocks: Map<string, any> },
) {
  const events = [
    "PointsEarned",
    "PointsRedeemed",
    "PointsExpired",
    "PaymentRefunded",
  ];
  const query = {
    events: events.map((eventName) => ({
      eventName,
      select: [{ type: "tx_hash", alias: "txHash" }],
      filter: {
        rule: "and",
        children: [
          {
            fieldType: "contract_address",
            operator: "equal",
            value: config.LOYALTY_PAYMENT_ADDRESS,
          },
          {
            fieldType: "input",
            inputIndex: eventName === "PointsExpired" ? 1 : 2,
            operator: "equal",
            value: wallet.address,
          },
        ],
      },
    })),
  };
  const hashes = new Set<string>();
  let complete = false;
  for (let offset = 0; offset < 1000; offset += 50) {
    const page = await multibaas.request(
      `/queries?limit=50&offset=${offset}`,
      query,
    );
    if (!Array.isArray(page?.rows)) throw new Error("Invalid loyalty history");
    for (const row of page.rows) {
      const value = String(row.txHash).toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(value))
        throw new Error("Invalid indexed transaction hash");
      hashes.add(value);
    }
    if (page.rows.length < 50) {
      complete = true;
      break;
    }
  }
  if (!complete)
    throw new AppError(
      "loyalty_history_limit",
      "This loyalty history requires additional pagination.",
      503,
    );
  for (const row of (
    await pool.query(
      "SELECT tx_hash FROM loyalty_receipt_events WHERE wallet_id=$1 AND router_address=$2 UNION SELECT tx_hash FROM loyalty_refunds WHERE payer=$3 AND stage='confirmed' AND router_address=$2",
      [wallet.id, config.LOYALTY_PAYMENT_ADDRESS, wallet.address],
    )
  ).rows)
    if (row.tx_hash) hashes.add(String(row.tx_hash).toLowerCase());
  const shops = new Map(
    (await pool.query("SELECT id,name FROM merchants")).rows.map((m) => [
      merchantBytes32(m.id),
      m,
    ]),
  );
  const history = [];
  for (const txHash of hashes) {
    let receipt = cache.receipts.get(txHash);
    if (!receipt) {
      receipt = (await multibaas.receipt(txHash)).data;
      if (receipt) cache.receipts.set(txHash, receipt);
    }
    if (
      !receipt ||
      BigInt(receipt.status) !== 1n ||
      BigInt(receipt.blockNumber) > BigInt(anchor.number)
    )
      continue;
    if (String(receipt.transactionHash).toLowerCase() !== txHash.toLowerCase())
      throw new Error("Loyalty transaction hash mismatch");
    let block = cache.blocks.get(String(receipt.blockNumber));
    if (!block) {
      block = await multibaas.block(receipt.blockNumber);
      cache.blocks.set(String(receipt.blockNumber), block);
    }
    if (block.hash !== receipt.blockHash) continue;
    for (const log of receipt.logs)
      history.push(
        ...historyFromLoyaltyLog(
          log,
          wallet,
          shops,
          txHash,
          iso(block.timestamp),
          unit,
        ),
      );
  }
  return [...new Map(history.map((event) => [event.id, event])).values()];
}
async function merchantSummary(
  mid: string,
  anchor: ConfirmedRewardAnchor,
  unit: bigint,
) {
  const wallets = await enumerate(
    "merchantWallets",
    merchantBytes32(mid),
    anchor,
  );
  let earned = 0n,
    redeemed = 0n,
    expired = 0n,
    restored = 0n,
    reversed = 0n,
    outstanding = 0n,
    outstandingUnits = 0n;
  for (const wallet of wallets) {
    const [earn, used, expire, restore, reverse] = tuple(
      await readLoyalty(
        "pointsSummary",
        [wallet, merchantBytes32(mid)],
        anchor,
      ),
      [
        "earnedUnits",
        "redeemedPoints",
        "expiredUnits",
        "restoredUnits",
        "reversedUnits",
        "debtUnits",
        "activeUnits",
      ],
    );
    const [balance, fraction] = tuple(
      await readLoyalty(
        "pointsBalance",
        [wallet, merchantBytes32(mid)],
        anchor,
      ),
      ["availablePoints", "fractionalUnits", "debtUnits", "nextExpiryAt"],
    );
    earned += BigInt(uint(earn));
    redeemed += BigInt(uint(used));
    expired += BigInt(uint(expire));
    restored += BigInt(uint(restore));
    reversed += BigInt(uint(reverse));
    outstanding += BigInt(uint(balance));
    outstandingUnits += BigInt(uint(balance)) * unit + BigInt(uint(fraction));
  }
  return {
    outstandingPoints: outstanding.toString(),
    outstandingUnits: outstandingUnits.toString(),
    earnedPoints: (earned / unit).toString(),
    redeemedPoints: redeemed.toString(),
    expiredPoints: (expired / unit).toString(),
    refundedPoints: (restored / unit).toString(),
    reversedPoints: (reversed / unit).toString(),
    earnedUnits: earned.toString(),
    expiredUnits: expired.toString(),
    refundedUnits: restored.toString(),
    reversedUnits: reversed.toString(),
    customerWallets: wallets.length,
  };
}
export async function loyaltyRoutes(app: FastifyInstance) {
  app.get("/v1/loyalty", async (req) => {
    const account = await authenticate(req);
    customer(account);
    const { cardId } = z
      .object({ cardId: z.uuid().optional() })
      .parse(req.query);
    if (cardId) await resolveCard(account.id, cardId);
    const base = {
      routerAddress: config.LOYALTY_PAYMENT_ADDRESS ?? null,
      token: {
        address: config.TOKEN_ADDRESS ?? "",
        symbol: config.TOKEN_SYMBOL,
        name: config.TOKEN_NAME,
        onchainSymbol: config.TOKEN_ONCHAIN_SYMBOL,
        decimals: config.TOKEN_DECIMALS,
      },
      pointValue: pointUnit(config.TOKEN_DECIMALS).toString(),
    };
    if (!hasLoyalty)
      return {
        ...base,
        status: "pending_setup",
        balances: null,
        history: null,
      };
    try {
      const anchor = await confirmedRewardBlock(),
        unit = await validatePointUnit(anchor),
        cache = { receipts: new Map(), blocks: new Map() };
      const wallets = (
        await pool.query(
          "SELECT * FROM wallets WHERE account_id=$1 AND status='ready' AND ($2::uuid IS NULL OR card_id=$2)",
          [account.id, cardId ?? null],
        )
      ).rows;
      const balances = [],
        history = [];
      for (const wallet of wallets) {
        balances.push(...(await walletBalances(wallet, anchor, unit)));
        history.push(...(await walletHistory(wallet, anchor, unit, cache)));
      }
      if ((await multibaas.block(anchor.number)).hash !== anchor.hash)
        throw new Error("Loyalty anchor changed");
      history.sort(
        (a, b) =>
          Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
          a.id.localeCompare(b.id),
      );
      return { ...base, status: "available", balances, history };
    } catch {
      return { ...base, status: "unavailable", balances: null, history: null };
    }
  });
  app.get("/v1/merchant/loyalty/program", async (req) => {
    const mid = merchant(await authenticate(req));
    const { operationId } = z
      .object({ operationId: z.uuid().optional() })
      .parse(req.query);
    const op = (
      await pool.query(
        "SELECT c.*,o.tx_hash,o.status operator_status FROM reward_campaign_operations c LEFT JOIN operator_transactions o ON o.id=c.campaign_operation_id WHERE c.merchant_id=$1 AND c.router_address=$2 AND ($3::uuid IS NULL OR c.id=$3) ORDER BY c.created_at DESC LIMIT 1",
        [mid, config.LOYALTY_PAYMENT_ADDRESS ?? null, operationId ?? null],
      )
    ).rows[0];
    if (operationId && !op)
      throw new AppError("not_found", "Program operation not found.", 404);
    const operation = op
      ? {
          id: op.id,
          status:
            op.stage === "confirmed"
              ? "confirmed"
              : op.stage === "failed"
                ? "failed"
                : op.error_code === "campaign_submission_unknown"
                  ? "reconciling"
                  : op.operator_status === "confirmed"
                    ? "pending"
                    : (op.operator_status ?? "queued"),
          txHash: op.tx_hash ?? null,
          errorCode: op.error_code,
        }
      : null;
    if (!hasLoyalty)
      return {
        status: "pending_setup",
        program: null,
        summary: null,
        operation,
      };
    try {
      const anchor = await confirmedRewardBlock(),
        unit = await validatePointUnit(anchor),
        program = await readLoyaltyProgram(mid, anchor),
        summary = await merchantSummary(mid, anchor, unit);
      if ((await multibaas.block(anchor.number)).hash !== anchor.hash)
        throw new Error("Loyalty anchor changed");
      return { status: "available", program, summary, operation };
    } catch {
      return { status: "unavailable", program: null, summary: null, operation };
    }
  });
  app.put("/v1/merchant/loyalty/program", async (req) => {
    const account = await authenticate(req),
      mid = merchant(account);
    const { requestId, ...terms } = loyaltyProgramSchema
      .extend({ requestId: z.uuid() })
      .strict()
      .parse(req.body);
    if (!hasLoyalty || !config.AWS_KMS_OPERATOR_KEY_ID)
      throw new AppError(
        "loyalty_unconfigured",
        "Points administration is not configured.",
        503,
      );
    const router = paymentRouter("loyalty");
    return transaction(async (db) => {
      if (
        !(
          await db.query(
            "SELECT id FROM merchants WHERE id=$1 AND enabled FOR UPDATE",
            [mid],
          )
        ).rowCount
      )
        throw new AppError(
          "merchant_disabled",
          "This merchant is disabled.",
          403,
        );
      const previous = (
        await db.query(
          "SELECT * FROM reward_campaign_operations WHERE account_id=$1 AND request_id=$2",
          [account.id, requestId],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.router_address !== router.address ||
          Object.keys(terms).some(
            (k) => previous.terms[k] !== terms[k as keyof typeof terms],
          )
        )
          throw new AppError(
            "request_conflict",
            "This request already has different program terms.",
            409,
          );
        return {
          id: previous.id,
          status:
            previous.stage === "confirmed"
              ? "confirmed"
              : previous.stage === "failed"
                ? "failed"
                : "queued",
        };
      }
      if (
        (
          await db.query(
            "SELECT 1 FROM reward_campaign_operations WHERE merchant_id=$1 AND router_address=$2 AND stage IN ('registration','campaign')",
            [mid, router.address],
          )
        ).rowCount
      )
        throw new AppError(
          "campaign_pending",
          "A program change is already being confirmed.",
          409,
        );
      const id = randomUUID();
      await db.query(
        "INSERT INTO reward_campaign_operations(id,merchant_id,account_id,request_id,router_address,router_label,chain_id,token_address,terms,register_operation_id,campaign_operation_id)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          id,
          mid,
          account.id,
          requestId,
          router.address,
          router.label,
          config.CHAIN_ID,
          config.TOKEN_ADDRESS,
          terms,
          randomUUID(),
          randomUUID(),
        ],
      );
      return { id, status: "queued" };
    });
  });
}

export async function loyaltyPaymentState(
  payer: string,
  invoiceId: string,
  anchor: ConfirmedRewardAnchor,
  address = config.LOYALTY_PAYMENT_ADDRESS!,
  label = config.LOYALTY_PAYMENT_CONTRACT,
) {
  const names = [
    "merchantId",
    "recipient",
    "grossAmount",
    "netAmount",
    "redeemedPoints",
    "earnedUnits",
    "debtRepaid",
    "earnedExpiresAt",
    "campaignVersion",
    "earnBps",
    "maxEarnPoints",
    "createdAt",
    "refunded",
  ];
  const values = tuple(
    await readLoyalty("payments", [payer, invoiceId], anchor, address, label),
    names,
  );
  return Object.fromEntries(names.map((key, index) => [key, values[index]]));
}
/** Exact confirmed event validation; returned values come from canonical contract state, never estimates. */
export function validateLoyaltyReceipt(
  logs: any[],
  job: any,
  state: Record<string, any>,
) {
  const router = routerSnapshot(job.expected_router, job.expected_router_label);
  if (router.kind !== "loyalty") return [];
  const unit = pointUnit(config.TOKEN_DECIMALS),
    points = BigInt(job.points_redeemed ?? 0);
  if (
    String(state.merchantId) !== merchantBytes32(job.merchant_id) ||
    String(state.recipient).toLowerCase() !== job.recipient ||
    uint(state.grossAmount) !== (job.gross_amount ?? job.amount) ||
    uint(state.netAmount) !== job.amount ||
    BigInt(uint(state.redeemedPoints)) !== points
  )
    throw new AppError(
      "loyalty_receipt_mismatch",
      "The confirmed points payment differs from the invoice.",
      502,
    );
  const earned = BigInt(uint(state.earnedUnits)),
    debt = BigInt(uint(state.debtRepaid)),
    rate = BigInt(uint(state.earnBps)),
    cap = BigInt(uint(state.maxEarnPoints)) * unit;
  const computed = (BigInt(job.amount) * rate) / 10000n;
  if (
    debt > earned ||
    (earned > 0n &&
      (rate <= 0n ||
        rate > 10000n ||
        cap <= 0n ||
        earned !== (computed < cap ? computed : cap) ||
        BigInt(uint(state.campaignVersion)) <= 0n))
  )
    throw new AppError(
      "loyalty_receipt_mismatch",
      "The earned point amount is invalid.",
      502,
    );
  const events: { kind: string; logIndex: string }[] = [];
  let earnedCount = 0,
    redeemedCount = 0;
  for (const log of logs) {
    if (log.removed || String(log.address).toLowerCase() !== router.address)
      continue;
    let event;
    try {
      event = loyaltyABI.parseLog(log);
    } catch {
      continue;
    }
    if (!event) continue;
    if (event.name === "PaymentRefunded")
      throw new AppError(
        "loyalty_receipt_mismatch",
        "Unexpected refund in a payment receipt.",
        502,
      );
    if (
      String(event.args.payer).toLowerCase() !== job.address ||
      String(event.args.merchantId) !== merchantBytes32(job.merchant_id) ||
      (event.name !== "PointsExpired" &&
        String(event.args.invoiceId) !== job.invoice_id)
    )
      throw new AppError(
        "loyalty_receipt_mismatch",
        "Points receipt identity differs.",
        502,
      );
    if (event.name === "PointsEarned") {
      earnedCount++;
      if (
        earned === 0n ||
        BigInt(event.args.earnedUnits) !== earned ||
        BigInt(event.args.debtRepaid) !== debt ||
        String(event.args.tokenAmount) !== job.amount ||
        String(event.args.expiresAt) !== uint(state.earnedExpiresAt) ||
        String(event.args.campaignVersion) !== uint(state.campaignVersion)
      )
        throw new AppError(
          "loyalty_receipt_mismatch",
          "Earned points differ from the confirmed contract state.",
          502,
        );
    }
    if (event.name === "PointsRedeemed") {
      redeemedCount++;
      if (
        points <= 0n ||
        BigInt(event.args.points) !== points ||
        BigInt(event.args.discount) !== points * unit ||
        String(event.args.discount) !== job.discount_amount
      )
        throw new AppError(
          "loyalty_receipt_mismatch",
          "Redeemed points differ from the signed quote.",
          502,
        );
    }
    events.push({
      kind:
        event.name === "PointsEarned"
          ? "earned"
          : event.name === "PointsRedeemed"
            ? "redeemed"
            : "expired",
      logIndex: BigInt(log.logIndex).toString(),
    });
  }
  if (
    earnedCount !== (earned > 0n ? 1 : 0) ||
    redeemedCount !== (points > 0n ? 1 : 0)
  )
    throw new AppError(
      "loyalty_receipt_missing",
      "Expected point events are missing or duplicated.",
      502,
    );
  return events;
}
