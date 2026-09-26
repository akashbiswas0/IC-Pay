import { randomUUID } from "node:crypto";
import { Interface } from "ethers";
import type { PoolClient } from "pg";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config, hasRewards, hasCollectibles } from "./config.js";
import { pool, transaction } from "./db.js";
import { authenticate, customer, merchant } from "./auth.js";
import { amountSchema } from "./protocol.js";
import { AppError } from "./errors.js";
import {
  multibaas,
  merchantBytes32,
  MULTIBAAS_PAGE_SIZE,
  decodeTokenBalance,
} from "./multibaas.js";
import { paymentRouter, routerSnapshot } from "./payment-router.js";
import {
  readRewardAtBlock,
  type ConfirmedRewardAnchor,
} from "./reward-read.js";
import { resolveCard } from "./card-wallets.js";
export const rewardABI = new Interface([
  "event RewardIssued(uint256 indexed voucherId,address indexed payer,bytes32 indexed merchantId,bytes32 invoiceId,uint64 campaignVersion,uint256 minPurchase,uint16 discountBps,uint256 maxDiscount,uint64 expiresAt)",
  "event RewardRedeemed(uint256 indexed voucherId,address indexed payer,bytes32 indexed merchantId,bytes32 invoiceId,uint256 grossAmount,uint256 discount,uint256 netAmount)",
]);
export const creditABI = new Interface([
  "event CreditIssued(uint256 indexed voucherId,address indexed payer,bytes32 indexed merchantId,bytes32 invoiceId,uint64 campaignVersion,uint256 purchaseAmount,uint256 creditAmount,uint16 earnBps,uint256 maxCredit,uint64 expiresAt)",
  "event CreditRedeemed(uint256 indexed voucherId,address indexed payer,bytes32 indexed merchantId,bytes32 invoiceId,uint256 grossAmount,uint256 discount,uint256 netAmount,uint256 remainingCredit)",
]);
export function collectibleImage(uri: unknown): string | null {
  if (
    typeof uri !== "string" ||
    uri.length > 65536 ||
    !uri.startsWith("data:application/json;base64,") ||
    !config.COLLECTIBLE_ARTWORK_BASE_URL
  )
    return null;
  try {
    const payload = JSON.parse(
      Buffer.from(uri.slice(29), "base64").toString("utf8"),
    );
    const image = new URL(payload.image),
      base = new URL(config.COLLECTIBLE_ARTWORK_BASE_URL);
    return image.protocol === "https:" &&
      !image.username &&
      !image.password &&
      !image.search &&
      !image.hash &&
      image.origin === base.origin &&
      image.pathname.startsWith(base.pathname)
      ? image.toString()
      : null;
  } catch {
    return null;
  }
}
export function tuple(output: any, names: string[]): any[] {
  if (Array.isArray(output) && output.length === names.length) return output;
  if (
    output &&
    typeof output === "object" &&
    names.every((n) => Object.hasOwn(output, n))
  )
    return names.map((n) => output[n]);
  throw new AppError(
    "invalid_reward_response",
    "The reward contract returned an unexpected response.",
    502,
  );
}
const integer = (v: unknown) => decodeTokenBalance(v);
function integerNumber(value: unknown) {
  const parsed = Number(integer(value));
  if (!Number.isSafeInteger(parsed))
    throw new AppError(
      "invalid_reward_response",
      "Reward integer exceeds the supported range.",
      502,
    );
  return parsed;
}
const iso = (seconds: string) => new Date(Number(seconds) * 1000).toISOString();
const explorer = (tx: string | null) =>
  tx && config.EXPLORER_URL
    ? `${config.EXPLORER_URL.replace(/\/$/, "")}/tx/${tx}`
    : null;
export async function confirmedRewardBlock() {
  await multibaas.validateTokenReadChain();
  const head = await multibaas.head();
  const height = BigInt(head.number) - BigInt(config.CONFIRMATIONS) + 1n;
  if (height < 0n)
    throw new AppError(
      "rewards_unavailable",
      "Waiting for chain confirmations.",
      503,
    );
  const block = await multibaas.block(height.toString());
  return {
    number: height.toString(),
    hash: block.hash,
    timestamp: Number(block.timestamp),
  };
}
export async function readCampaign(
  merchantId: string,
  routerAddress = config.REWARD_PAYMENT_ADDRESS!,
  label = config.REWARD_PAYMENT_CONTRACT,
  anchor?: ConfirmedRewardAnchor,
) {
  const block = anchor ?? (await confirmedRewardBlock());
  const result = await readRewardAtBlock(
    routerAddress,
    label,
    "campaigns",
    [merchantBytes32(merchantId)],
    block,
  );
  const credit = routerSnapshot(routerAddress, label).kind === "collectibles";
  const [enabled, minPurchase, rate, cap, validitySeconds, version] = tuple(
    result.output,
    [
      "enabled",
      "minPurchase",
      credit ? "earnBps" : "discountBps",
      credit ? "maxCredit" : "maxDiscount",
      "validitySeconds",
      "version",
    ],
  );
  if (typeof enabled !== "boolean")
    throw new AppError(
      "invalid_reward_response",
      "Invalid campaign status.",
      502,
    );
  return {
    enabled,
    minPurchase: integer(minPurchase),
    ...(credit
      ? { earnBps: integerNumber(rate), maxCredit: integer(cap) }
      : { discountBps: integerNumber(rate), maxDiscount: integer(cap) }),
    validitySeconds: integerNumber(validitySeconds),
    version: integerNumber(version),
  };
}
export type RewardReadContext = {
  block?: Awaited<ReturnType<typeof confirmedRewardBlock>>;
  receipts: Map<string, any>;
  blocks: Map<string, any>;
  deferCanonicalCheck?: boolean;
};
export async function walletVouchers(
  wallet: any,
  includeSources = true,
  cache: RewardReadContext = { receipts: new Map(), blocks: new Map() },
  kind: "rewards" | "collectibles" = "rewards",
) {
  if (!(kind === "collectibles" ? hasCollectibles : hasRewards))
    throw new AppError(
      "rewards_unconfigured",
      "Rewards are not configured.",
      503,
    );
  const router = paymentRouter(kind);
  const credit = kind === "collectibles";
  const eventABI = credit ? creditABI : rewardABI;
  const block = (cache.block ??= await confirmedRewardBlock());
  const ids: string[] = [];
  let total = 0n;
  for (let offset = 0; offset < 1000; offset += MULTIBAAS_PAGE_SIZE) {
    const r = await readRewardAtBlock(
      router.address,
      router.label,
      "issuedVoucherIds",
      [wallet.address, String(offset), String(MULTIBAAS_PAGE_SIZE)],
      block,
    );
    const [page, count] = tuple(r.output, ["voucherIds", "total"]);
    if (!Array.isArray(page))
      throw new AppError(
        "invalid_reward_response",
        "Invalid voucher list.",
        502,
      );
    total = BigInt(integer(count));
    ids.push(...page.map(integer));
    if (BigInt(ids.length) >= total) break;
  }
  if (BigInt(ids.length) < total)
    throw new AppError(
      "reward_history_limit",
      "This wallet requires paginated reward history support.",
      503,
    );
  const merchants = (await pool.query("SELECT id,name FROM merchants")).rows;
  const byKey = new Map(merchants.map((m) => [merchantBytes32(m.id), m]));
  const reserved = await reservedRewardIds(wallet.id, router.address);
  const vouchers = [];
  for (const id of ids) {
    const r = await readRewardAtBlock(
      router.address,
      router.label,
      "vouchers",
      [id],
      block,
    );
    const names = credit
      ? [
          "merchantId",
          "holder",
          "purchaseAmount",
          "creditAmount",
          "remainingCredit",
          "earnBps",
          "maxCredit",
          "campaignVersion",
          "issuedAt",
          "expiresAt",
          "redeemed",
          "redeemedAt",
          "issuedInvoiceId",
          "redeemedInvoiceId",
        ]
      : [
          "merchantId",
          "holder",
          "minPurchase",
          "discountBps",
          "maxDiscount",
          "campaignVersion",
          "issuedAt",
          "expiresAt",
          "redeemed",
          "redeemedAt",
          "issuedInvoiceId",
          "redeemedInvoiceId",
        ];
    const fields = Object.fromEntries(
      names.map((name, index) => [name, tuple(r.output, names)[index]]),
    );
    const {
      merchantId: merchantKey,
      holder,
      minPurchase,
      discountBps,
      maxDiscount,
      campaignVersion,
      issuedAt,
      expiresAt,
      redeemed,
      redeemedAt,
      issuedInvoiceId,
      redeemedInvoiceId,
      purchaseAmount,
      creditAmount,
      remainingCredit,
      earnBps,
      maxCredit,
    } = fields;
    if (
      String(holder).toLowerCase() !== wallet.address ||
      typeof redeemed !== "boolean"
    )
      throw new AppError(
        "invalid_reward_owner",
        "Voucher owner does not match the wallet.",
        502,
      );
    const shop = byKey.get(String(merchantKey));
    let imageUrl: string | null = null;
    if (credit) {
      const metadata = await readRewardAtBlock(
        router.address,
        router.label,
        "tokenURI",
        [id],
        block,
      );
      imageUrl = collectibleImage(
        Array.isArray(metadata.output) ? metadata.output[0] : metadata.output,
      );
    }
    vouchers.push({
      id,
      tokenId: id,
      contractAddress: router.address,
      collectionKey: `${router.address}:${id}`,
      rewardType: credit ? ("credit" as const) : ("percentage" as const),
      imageUrl,
      creditAmount: credit ? integer(creditAmount) : null,
      remainingCredit: credit ? integer(remainingCredit) : null,
      purchaseAmount: credit ? integer(purchaseAmount) : null,
      earnBps: credit ? integerNumber(earnBps) : null,
      maxCredit: credit ? integer(maxCredit) : null,
      nftOwned: credit || !redeemed,
      symbol: config.TOKEN_SYMBOL,
      name: config.TOKEN_NAME,
      onchainSymbol: config.TOKEN_ONCHAIN_SYMBOL,
      decimals: config.TOKEN_DECIMALS,
      events: [] as {
        id: string;
        kind: "earned" | "redeemed";
        createdAt: string;
        txHash: string;
        explorerUrl: string | null;
        discountAmount?: string;
        remainingCredit?: string;
      }[],
      cardId: wallet.card_id,
      walletAddress: wallet.address,
      merchantId: shop?.id ?? String(merchantKey),
      merchantName: shop?.name ?? "Unlisted merchant",
      merchantKey: String(merchantKey),
      minPurchase: credit ? null : integer(minPurchase),
      discountBps: credit ? null : integerNumber(discountBps),
      maxDiscount: credit ? null : integer(maxDiscount),
      campaignVersion: integer(campaignVersion),
      earnedAt: iso(integer(issuedAt)),
      expiresAt: iso(integer(expiresAt)),
      redeemedAt: redeemed ? iso(integer(redeemedAt)) : null,
      status: redeemed
        ? "used"
        : reserved.has(id)
          ? "reserved"
          : Number(expiresAt) * 1000 <= Date.now()
            ? "expired"
            : "available",
      issuedInvoiceId: String(issuedInvoiceId),
      redeemedInvoiceId: String(redeemedInvoiceId),
      earnedTxHash: null as string | null,
      redeemedTxHash: null as string | null,
      earnedExplorerUrl: null as string | null,
      redeemedExplorerUrl: null as string | null,
    });
  }
  if (includeSources && vouchers.length) {
    const query = {
      events: (credit
        ? ["CreditIssued", "CreditRedeemed"]
        : ["RewardIssued", "RewardRedeemed"]
      ).map((eventName) => ({
        eventName,
        select: [
          { type: "input", inputIndex: 0, alias: "rewardId" },
          { type: "tx_hash", alias: "txHash" },
        ],
        filter: {
          rule: "and",
          children: [
            {
              fieldType: "contract_address",
              operator: "equal",
              value: router.address,
            },
            {
              fieldType: "input",
              inputIndex: 1,
              operator: "equal",
              value: wallet.address,
            },
          ],
        },
      })),
    };
    const indexed: { rows: any[] } = { rows: [] };
    for (let offset = 0; offset < 1000; offset += 50) {
      const page = await multibaas.request(
        `/queries?limit=50&offset=${offset}`,
        query,
      );
      if (!Array.isArray(page?.rows))
        throw new AppError(
          "invalid_reward_response",
          "Reward indexing unavailable.",
          502,
        );
      indexed.rows.push(...page.rows);
      if (page.rows.length < 50) break;
    }
    if (!Array.isArray(indexed?.rows))
      throw new AppError(
        "invalid_reward_response",
        "Reward event indexing is unavailable.",
        502,
      );
    const recorded = (
      await pool.query(
        "SELECT DISTINCT e.tx_hash FROM reward_receipt_events e JOIN payment_jobs j ON j.invoice_id=e.invoice_id WHERE j.wallet_id=$1 AND e.router_address=$2 AND e.chain_id=$3",
        [wallet.id, router.address, config.CHAIN_ID],
      )
    ).rows;
    for (const txHash of new Set<string>([
      ...indexed.rows.map((r: any) => String(r.txHash)),
      ...recorded.map((r) => String(r.tx_hash)),
    ])) {
      let receipt = cache.receipts.get(txHash);
      if (!receipt) {
        receipt = (await multibaas.receipt(txHash))?.data;
        if (receipt) cache.receipts.set(txHash, receipt);
      }
      if (
        !receipt ||
        String(receipt.transactionHash).toLowerCase() !==
          txHash.toLowerCase() ||
        BigInt(receipt.status) !== 1n ||
        BigInt(receipt.blockNumber) > BigInt(block.number)
      )
        continue;
      let canonical = cache.blocks.get(receipt.blockNumber);
      if (!canonical) {
        canonical = await multibaas.block(receipt.blockNumber);
        cache.blocks.set(receipt.blockNumber, canonical);
      }
      if (canonical.hash !== receipt.blockHash) continue;
      for (const log of receipt.logs) {
        if (log.removed || String(log.address).toLowerCase() !== router.address)
          continue;
        let decoded;
        try {
          decoded = eventABI.parseLog(log);
        } catch {
          continue;
        }
        if (
          !decoded ||
          String(decoded.args.payer).toLowerCase() !== wallet.address
        )
          continue;
        const voucher = vouchers.find(
          (v) => v.id === String(decoded.args.voucherId),
        );
        if (!voucher || decoded.args.merchantId !== voucher.merchantKey)
          continue;
        const earned =
          decoded.name === (credit ? "CreditIssued" : "RewardIssued");
        const redeemedEvent =
          decoded.name === (credit ? "CreditRedeemed" : "RewardRedeemed");
        if (credit && (earned || redeemedEvent)) {
          if (
            earned &&
            (decoded.args.invoiceId !== voucher.issuedInvoiceId ||
              String(decoded.args.creditAmount) !== voucher.creditAmount ||
              String(decoded.args.purchaseAmount) !== voucher.purchaseAmount ||
              Number(decoded.args.earnBps) !== voucher.earnBps ||
              String(decoded.args.maxCredit) !== voucher.maxCredit ||
              String(decoded.args.campaignVersion) !==
                voucher.campaignVersion ||
              iso(String(decoded.args.expiresAt)) !== voucher.expiresAt)
          )
            continue;
          voucher.events.push({
            id: `${router.address}:${txHash}:${log.logIndex}`,
            kind: earned ? "earned" : "redeemed",
            createdAt: iso(String(canonical.timestamp)),
            txHash,
            explorerUrl: explorer(txHash),
            ...(redeemedEvent
              ? {
                  discountAmount: String(decoded.args.discount),
                  remainingCredit: String(decoded.args.remainingCredit),
                }
              : {}),
          });
          if (earned) {
            voucher.earnedTxHash = txHash;
            voucher.earnedExplorerUrl = explorer(txHash);
          }
          if (
            redeemedEvent &&
            decoded.args.invoiceId === voucher.redeemedInvoiceId
          ) {
            voucher.redeemedTxHash = txHash;
            voucher.redeemedExplorerUrl = explorer(txHash);
          }
          continue;
        }
        if (
          decoded.name === "RewardIssued" &&
          decoded.args.invoiceId === voucher.issuedInvoiceId &&
          String(decoded.args.campaignVersion) === voucher.campaignVersion &&
          String(decoded.args.maxDiscount) === voucher.maxDiscount &&
          Number(decoded.args.discountBps) === voucher.discountBps &&
          String(decoded.args.minPurchase) === voucher.minPurchase &&
          iso(String(decoded.args.expiresAt)) === voucher.expiresAt
        ) {
          voucher.earnedTxHash = txHash;
          voucher.earnedExplorerUrl = explorer(txHash);
          voucher.events.push({
            id: `${router.address}:${txHash}:${log.logIndex}`,
            kind: "earned",
            createdAt: iso(String(canonical.timestamp)),
            txHash,
            explorerUrl: explorer(txHash),
          });
        }
        if (
          decoded.name === "RewardRedeemed" &&
          decoded.args.invoiceId === voucher.redeemedInvoiceId &&
          voucher.status === "used"
        ) {
          voucher.redeemedTxHash = txHash;
          voucher.redeemedExplorerUrl = explorer(txHash);
          voucher.events.push({
            id: `${router.address}:${txHash}:${log.logIndex}`,
            kind: "redeemed",
            createdAt: iso(String(canonical.timestamp)),
            txHash,
            explorerUrl: explorer(txHash),
            discountAmount: String(decoded.args.discount),
          });
        }
      }
    }
  }
  // All views in this snapshot must still refer to the accepted canonical block.
  if (
    !cache.deferCanonicalCheck &&
    (await multibaas.block(block.number)).hash !== block.hash
  )
    throw new AppError(
      "reward_reorganization",
      "Reward state is being reconciled.",
      503,
    );
  for (const voucher of vouchers)
    voucher.events.sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  return vouchers;
}
export function discountFor(gross: string, bps: number, cap: string): bigint {
  const percentage = (BigInt(gross) * BigInt(bps)) / 10000n;
  return percentage < BigInt(cap) ? percentage : BigInt(cap);
}
export async function chooseReward(
  db: PoolClient,
  wallet: any,
  merchantId: string,
  gross: string,
  jobId: string,
  kind: "rewards" | "collectibles" = "rewards",
) {
  const choices = (await walletVouchers(wallet, false, undefined, kind))
    .filter(
      (v) =>
        v.merchantId === merchantId &&
        v.status === "available" &&
        (v.rewardType === "credit"
          ? BigInt(v.remainingCredit!) > 0n
          : discountFor(gross, v.discountBps!, v.maxDiscount!) > 0n &&
            discountFor(gross, v.discountBps!, v.maxDiscount!) < BigInt(gross)),
    )
    .sort(
      (a, b) =>
        Date.parse(a.expiresAt) - Date.parse(b.expiresAt) ||
        (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
    );
  for (const voucher of choices) {
    const router = paymentRouter(kind);
    const quote = await multibaas.call(
      router.address,
      router.label,
      "quoteReward",
      [voucher.id, wallet.address, merchantBytes32(merchantId), gross],
    );
    const [discount, netAmount] = tuple(quote.output, [
      "discount",
      "netAmount",
    ]);
    const net = integer(netAmount),
      off = integer(discount);
    if (
      BigInt(off) <= 0n ||
      (kind === "rewards" ? BigInt(net) <= 0n : BigInt(net) < 0n) ||
      (kind === "collectibles" &&
        BigInt(off) !==
          (BigInt(voucher.remainingCredit!) < BigInt(gross)
            ? BigInt(voucher.remainingCredit!)
            : BigInt(gross))) ||
      BigInt(net) + BigInt(off) !== BigInt(gross)
    )
      throw new AppError(
        "invalid_reward_quote",
        "Reward quote does not match the invoice.",
        502,
      );
    return {
      rewardId: voucher.id,
      discountAmount: off,
      netAmount: net,
      creditBefore: voucher.remainingCredit,
    };
  }
  throw new AppError(
    "reward_unavailable",
    "No eligible confirmed reward is available. Recreate the payment without a reward to charge full price.",
    409,
  );
}
export async function reservedRewardIds(walletId: string, router: string) {
  return new Set<string>(
    (
      await pool.query(
        "SELECT r.reward_id FROM reward_reservations r JOIN payment_jobs j ON j.id=r.job_id WHERE r.wallet_id=$1 AND r.router_address=$2 AND r.chain_id=$3 AND (r.released_at IS NULL OR j.status IN ('submitting','pending','reconciling'))",
        [walletId, router, config.CHAIN_ID],
      )
    ).rows.map((r) => r.reward_id),
  );
}
export async function consumeRewardReservation(db: PoolClient, job: any) {
  if (!job.reward_id) return;
  await db.query(
    "UPDATE reward_reservations SET consumed_at=now(),released_at=CASE WHEN $2 THEN now() ELSE released_at END WHERE job_id=$1 AND released_at IS NULL",
    [
      job.id,
      routerSnapshot(job.expected_router, job.expected_router_label).kind ===
        "collectibles",
    ],
  );
}
export async function reserveReward(
  db: PoolClient,
  router: string,
  rewardId: string,
  walletId: string,
  jobId: string,
) {
  const result = await db.query(
    "INSERT INTO reward_reservations(id,router_address,reward_id,wallet_id,job_id,chain_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(chain_id,router_address,reward_id) WHERE released_at IS NULL DO NOTHING RETURNING id",
    [randomUUID(), router, rewardId, walletId, jobId, config.CHAIN_ID],
  );
  if (!result.rowCount)
    throw new AppError(
      "reward_reserved",
      "That reward is already committed to another payment. Try another invoice after it resolves.",
      409,
    );
}
export function validateRewardReceipt(logs: any[], job: any) {
  const router = routerSnapshot(job.expected_router, job.expected_router_label);
  if (router.kind === "legacy") return [];
  const credit = router.kind === "collectibles";
  const events = [];
  for (const log of logs) {
    if (log.removed || String(log.address).toLowerCase() !== router.address)
      continue;
    let parsed;
    try {
      parsed = (credit ? creditABI : rewardABI).parseLog(log);
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (
      parsed.args.invoiceId !== job.invoice_id ||
      parsed.args.merchantId !== merchantBytes32(job.merchant_id) ||
      String(parsed.args.payer).toLowerCase() !== job.address
    )
      throw new AppError(
        "reward_receipt_mismatch",
        "Reward receipt does not match this payment.",
        502,
      );
    if (parsed.name === (credit ? "CreditRedeemed" : "RewardRedeemed")) {
      if (
        !job.reward_id ||
        String(parsed.args.voucherId) !== job.reward_id ||
        String(parsed.args.grossAmount) !== job.gross_amount ||
        String(parsed.args.discount) !== job.discount_amount ||
        String(parsed.args.netAmount) !== job.amount ||
        (credit &&
          (job.reward_credit_before == null ||
            BigInt(job.gross_amount) <= 0n ||
            BigInt(job.amount) + BigInt(job.discount_amount) !==
              BigInt(job.gross_amount) ||
            BigInt(job.discount_amount) !==
              (BigInt(job.reward_credit_before) < BigInt(job.gross_amount)
                ? BigInt(job.reward_credit_before)
                : BigInt(job.gross_amount)) ||
            BigInt(parsed.args.remainingCredit) !==
              BigInt(job.reward_credit_before) - BigInt(job.discount_amount)))
      )
        throw new AppError(
          "reward_receipt_mismatch",
          "Reward redemption terms differ.",
          502,
        );
    } else {
      const rate = Number(
          credit ? parsed.args.earnBps : parsed.args.discountBps,
        ),
        cap = BigInt(credit ? parsed.args.maxCredit : parsed.args.maxDiscount);
      const gross = BigInt(job.gross_amount ?? job.amount);
      const earned = (gross * BigInt(rate)) / 10000n;
      if (
        job.reward_id ||
        rate <= 0 ||
        rate > (credit ? 10000 : 9999) ||
        cap <= 0n ||
        BigInt(parsed.args.campaignVersion) <= 0n ||
        (job.created_at instanceof Date &&
          BigInt(parsed.args.expiresAt) <=
            BigInt(Math.floor(job.created_at.getTime() / 1000))) ||
        (credit
          ? BigInt(parsed.args.purchaseAmount) !== gross ||
            BigInt(parsed.args.creditAmount) !==
              (earned < cap ? earned : cap) ||
            BigInt(parsed.args.creditAmount) <= 0n
          : BigInt(parsed.args.minPurchase) > gross)
      )
        throw new AppError(
          "reward_receipt_mismatch",
          "Invalid reward issuance.",
          502,
        );
    }
    events.push({
      kind:
        parsed.name === (credit ? "CreditIssued" : "RewardIssued")
          ? "earned"
          : "redeemed",
      rewardId: String(parsed.args.voucherId),
      logIndex: BigInt(log.logIndex).toString(),
    });
  }
  if (job.reward_id && (events.length !== 1 || events[0]?.kind !== "redeemed"))
    throw new AppError(
      "reward_receipt_missing",
      "Expected reward redemption was not found.",
      502,
    );
  if (!job.reward_id && events.length > 1)
    throw new AppError(
      "reward_receipt_mismatch",
      "Unexpected duplicate reward issuance.",
      502,
    );
  return events;
}
export const campaignSchema = z.object({
  enabled: z.boolean(),
  minPurchase: amountSchema,
  discountBps: z.number().int().min(1).max(9999),
  maxDiscount: amountSchema,
  validitySeconds: z.number().int().min(60).max(31536000),
});
export const collectibleCampaignSchema = z.object({
  enabled: z.boolean(),
  minPurchase: amountSchema,
  earnBps: z.number().int().min(1).max(10000),
  maxCredit: amountSchema,
  validitySeconds: z.number().int().min(60).max(31536000),
});
export async function rewardRoutes(app: FastifyInstance) {
  app.get("/v1/rewards", async (req) => {
    const a = await authenticate(req);
    customer(a);
    const { cardId } = z
      .object({ cardId: z.uuid().optional() })
      .parse(req.query);
    if (cardId) await resolveCard(a.id, cardId);
    if (!hasRewards)
      return { status: "pending_setup", rewards: null, routerAddress: null };
    try {
      const wallets = (
        await pool.query(
          "SELECT * FROM wallets WHERE account_id=$1 AND status='ready' AND ($2::uuid IS NULL OR card_id=$2)",
          [a.id, cardId ?? null],
        )
      ).rows;
      const rewards = [];
      const cache: RewardReadContext = {
        receipts: new Map(),
        blocks: new Map(),
        deferCanonicalCheck: true,
      };
      for (const w of wallets)
        rewards.push(...(await walletVouchers(w, true, cache)));
      if (
        cache.block &&
        (await multibaas.block(cache.block.number)).hash !== cache.block.hash
      )
        throw new AppError(
          "reward_reorganization",
          "Reward state is being reconciled.",
          503,
        );
      return {
        status: "available",
        rewards,
        routerAddress: config.REWARD_PAYMENT_ADDRESS,
      };
    } catch {
      return {
        status: "unavailable",
        rewards: null,
        routerAddress: config.REWARD_PAYMENT_ADDRESS,
      };
    }
  });
  app.get("/v1/collectibles", async (req) => {
    const account = await authenticate(req);
    customer(account);
    const { cardId } = z
      .object({ cardId: z.uuid().optional() })
      .parse(req.query);
    if (cardId) await resolveCard(account.id, cardId);
    const routerAddress =
      config.COLLECTIBLE_PAYMENT_ADDRESS ??
      config.REWARD_PAYMENT_ADDRESS ??
      null;
    if (!hasCollectibles && !hasRewards)
      return { status: "pending_setup", items: null, routerAddress };
    try {
      const wallets = (
        await pool.query(
          "SELECT * FROM wallets WHERE account_id=$1 AND status='ready' AND ($2::uuid IS NULL OR card_id=$2)",
          [account.id, cardId ?? null],
        )
      ).rows;
      const cache: RewardReadContext = {
        receipts: new Map(),
        blocks: new Map(),
        deferCanonicalCheck: true,
      };
      const items = [];
      for (const wallet of wallets) {
        if (hasRewards)
          items.push(...(await walletVouchers(wallet, true, cache, "rewards")));
        if (hasCollectibles)
          items.push(
            ...(await walletVouchers(wallet, true, cache, "collectibles")),
          );
      }
      if (
        cache.block &&
        (await multibaas.block(cache.block.number)).hash !== cache.block.hash
      )
        throw new AppError(
          "reward_reorganization",
          "Collectibles are being reconciled.",
          503,
        );
      return { status: "available", items, routerAddress };
    } catch {
      return { status: "unavailable", items: null, routerAddress };
    }
  });
  for (const kind of ["rewards", "collectibles"] as const) {
    const route = `/v1/merchant/${kind}/campaign`;
    const enabled = kind === "collectibles" ? hasCollectibles : hasRewards;
    const address =
      kind === "collectibles"
        ? config.COLLECTIBLE_PAYMENT_ADDRESS
        : config.REWARD_PAYMENT_ADDRESS;
    const label =
      kind === "collectibles"
        ? config.COLLECTIBLE_PAYMENT_CONTRACT
        : config.REWARD_PAYMENT_CONTRACT;
    app.get(route, async (req) => {
      const mid = merchant(await authenticate(req));
      const { operationId } = z
        .object({ operationId: z.uuid().optional() })
        .parse(req.query);
      const op = (
        await pool.query(
          "SELECT c.*,o.tx_hash,o.status operator_status FROM reward_campaign_operations c LEFT JOIN operator_transactions o ON o.id=c.campaign_operation_id WHERE c.merchant_id=$1 AND ($2::uuid IS NULL OR c.id=$2) AND c.router_address=$3 ORDER BY c.created_at DESC LIMIT 1",
          [mid, operationId ?? null, address ?? null],
        )
      ).rows[0];
      if (operationId && !op)
        throw new AppError("not_found", "Campaign operation not found.", 404);
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
      if (!enabled)
        return { status: "pending_setup", campaign: null, operation };
      try {
        const block = await confirmedRewardBlock();
        const campaign = await readCampaign(mid, address, label, block);
        return {
          status: "available",
          campaign: campaign.version === 0 ? null : campaign,
          operation,
        };
      } catch {
        return { status: "unavailable", campaign: null, operation };
      }
    });
    app.put(route, async (req) => {
      const a = await authenticate(req),
        mid = merchant(a);
      const { requestId, ...terms } = (
        kind === "collectibles" ? collectibleCampaignSchema : campaignSchema
      )
        .extend({ requestId: z.uuid() })
        .strict()
        .parse(req.body);
      if (!enabled || !config.AWS_KMS_OPERATOR_KEY_ID)
        throw new AppError(
          "rewards_unconfigured",
          "Rewards administration is not configured.",
          503,
        );
      const router = paymentRouter(kind);
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
        const old = (
          await db.query(
            "SELECT * FROM reward_campaign_operations WHERE account_id=$1 AND request_id=$2",
            [a.id, requestId],
          )
        ).rows[0];
        if (old) {
          if (
            old.router_address !== router.address ||
            (JSON.stringify(old.terms) !== JSON.stringify(terms) &&
              Object.keys(terms).some(
                (k) => old.terms[k] !== terms[k as keyof typeof terms],
              ))
          )
            throw new AppError(
              "request_conflict",
              "This campaign request already has different terms.",
              409,
            );
          return {
            id: old.id,
            status:
              old.stage === "confirmed"
                ? "confirmed"
                : old.stage === "failed"
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
            "A campaign change is already being confirmed. Wait for it before creating another.",
            409,
          );
        const id = randomUUID();
        await db.query(
          "INSERT INTO reward_campaign_operations(id,merchant_id,account_id,request_id,router_address,router_label,chain_id,token_address,terms,register_operation_id,campaign_operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            id,
            mid,
            a.id,
            requestId,
            router.address,
            router.label,
            config.CHAIN_ID,
            config.TOKEN_ADDRESS,
            JSON.stringify(terms),
            randomUUID(),
            randomUUID(),
          ],
        );
        return { id, status: "queued" };
      });
    });
  }
}
