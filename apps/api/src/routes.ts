import { readRefundByInvoice } from "./loyalty-refunds.js";
import { wholePointsSchema } from "./loyalty-protocol.js";
import { choosePoints, reservePoints } from "./loyalty.js";
import {
  allowsPolicyRouter,
  validateRetainedAllowance,
} from "./policy-router.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  authenticate,
  customer,
  merchant,
  authenticationToken,
  browserSessionCookie,
} from "./auth.js";
import {
  config,
  hasPayments,
  hasWorld,
  hasTokenReads,
  hasRewards,
  hasCollectibles,
  hasLoyalty,
  hasFundingHistory,
  hasTestFunding,
} from "./config.js";
import { pool, transaction } from "./db.js";
import { AppError } from "./errors.js";
import { multibaas, historicalMultibaas } from "./multibaas.js";
import { mergeFundingSources } from "./funding-history.js";
import { paymentRouter, routerSnapshot } from "./payment-router.js";
import { chooseReward, reserveReward } from "./rewards.js";
import { publicCard } from "./cards.js";
import {
  resolveCard,
  readWallet,
  publicPolicy,
  allowanceSufficient,
} from "./card-wallets.js";
import { kmsWallets, requireAwsWallet } from "./wallets.js";
import {
  requestAllowance,
  requestInvoice,
  remainingPolicyAllowance,
} from "./payment-requests.js";
import {
  amountSchema,
  scanSchema,
  cardHash,
  hash,
  publicKey,
  randomToken,
  verifyScan,
  withinBudget,
} from "./protocol.js";
const invoiceParams = z.object({ id: z.string().regex(/^0x[0-9a-f]{64}$/) });
const explorer = (tx: string | null) =>
  tx && config.EXPLORER_URL
    ? `${config.EXPLORER_URL.replace(/\/$/, "")}/tx/${tx}`
    : null;
function invoice(row: any) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    recipient: row.recipient,
    amount: row.amount,
    grossAmount: row.gross_amount ?? row.amount,
    discountAmount: row.discount_amount ?? "0",
    useReward: row.use_reward ?? false,
    rewardId: row.reward_id ?? null,
    routerAddress: row.router_address ?? config.PAYMENT_ADDRESS ?? null,
    scanVersion: row.scan_version ?? 1,
    routerKind:
      row.reward_model === "points"
        ? "loyalty"
        : row.reward_model === "credit"
          ? "collectibles"
          : row.scan_version === 2
            ? "rewards"
            : "legacy",
    maxPoints: row.max_points ?? null,
    pointsRedeemed: row.points_redeemed ?? "0",
    token: row.token,
    chainId: row.chain_id,
    expiresAt: row.expires_at.toISOString(),
    status:
      row.status === "awaiting_tap" && row.expires_at.getTime() <= Date.now()
        ? "expired"
        : row.status,
    errorCode: row.error_code ?? null,
    txHash: row.tx_hash ?? null,
    explorerUrl: explorer(row.tx_hash ?? null),
  };
}
function policy(row: any) {
  return publicPolicy(row);
}

export async function routes(app: FastifyInstance) {
  app.get("/health/live", async () => ({ status: "ok" }));
  const ready = async (
    _req: unknown,
    reply: import("fastify").FastifyReply,
  ) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  };
  app.get("/health", ready);
  app.get("/health/ready", ready);
  app.get("/v1/config", async () => ({
    chainId: config.CHAIN_ID ?? "",
    token: {
      address: config.TOKEN_ADDRESS ?? "",
      symbol: config.TOKEN_SYMBOL,
      name: config.TOKEN_NAME,
      onchainSymbol: config.TOKEN_ONCHAIN_SYMBOL,
      decimals: config.TOKEN_DECIMALS,
    },
    explorerUrl: config.EXPLORER_URL ?? null,
    world: {
      appId: config.WORLD_APP_ID ?? "",
      environment: config.WORLD_ENVIRONMENT,
    },
    paymentRouter: hasPayments ? paymentRouter() : null,
    collectiblesRouter: hasCollectibles ? paymentRouter("collectibles") : null,
    capabilities: {
      testFunding: hasTestFunding,
      rewards: hasRewards,
      collectibles: hasCollectibles,
      loyalty: hasLoyalty,
      payments: hasPayments,
      world: hasWorld,
      multipleCards: true,
      accountRecovery: true,
      cardWallets: true,
    },
  }));
  app.get("/v1/me", async (req) => {
    const a = await authenticate(req);
    return {
      id: a.id,
      role: a.role,
      verified: a.verified,
      merchantId: a.merchant_id,
    };
  });
  app.post("/v1/logout", async (req, reply) => {
    await authenticate(req);
    await pool.query(
      "UPDATE sessions SET revoked_at=now() WHERE token_hash=$1",
      [hash(authenticationToken(req))],
    );
    reply.header("Set-Cookie", browserSessionCookie("", 0));
    return { signedOut: true };
  });
  app.get("/v1/merchants", async (req) => {
    await authenticate(req);
    return {
      merchants: (
        await pool.query(
          "SELECT id,name FROM merchants WHERE enabled ORDER BY name",
        )
      ).rows,
    };
  });
  app.get("/v1/dashboard", async (req) => {
    const a = await authenticate(req);
    const [wallets, linked, policies, payments, merchants] = await Promise.all([
      pool.query("SELECT * FROM wallets WHERE account_id=$1", [a.id]),
      pool.query(
        "SELECT * FROM cards WHERE account_id=$1 AND removed_at IS NULL ORDER BY linked_at,id",
        [a.id],
      ),
      pool.query(
        "SELECT p.*,ARRAY(SELECT merchant_id FROM policy_merchants pm WHERE pm.policy_id=p.id) merchant_ids FROM policies p WHERE p.account_id=$1",
        [a.id],
      ),
      pool.query(
        "SELECT i.*,m.name merchant_name,j.tx_hash,j.error_code,j.card_id FROM invoices i JOIN merchants m ON m.id=i.merchant_id LEFT JOIN payment_jobs j ON j.invoice_id=i.id WHERE i.account_id=$1 OR i.merchant_id=$2 ORDER BY i.created_at DESC LIMIT 100",
        [a.id, a.merchant_id],
      ),
      a.merchant_id
        ? pool.query(
            "SELECT m.*,count(r.invoice_id)::int confirmed_count,COALESCE(sum(r.amount),0)::text received_total FROM merchants m LEFT JOIN invoices i ON i.merchant_id=m.id AND i.status='confirmed' LEFT JOIN receipts r ON r.invoice_id=i.id WHERE m.id=$1 GROUP BY m.id",
            [a.merchant_id],
          )
        : Promise.resolve({ rows: [] }),
    ]);
    const cards = await Promise.all(
      linked.rows.map(async (card) => {
        const wallet = wallets.rows.find((row) => row.card_id === card.id);
        const permission = policies.rows.find((row) => row.card_id === card.id);
        const walletView = await readWallet(wallet);
        return {
          ...publicCard(card),
          wallet: walletView,
          walletStatus:
            wallet?.status === "queued"
              ? "provisioning"
              : (wallet?.status ?? "none"),
          policy: publicPolicy(permission),
          allowanceSufficient:
            walletView?.balanceStatus === "available"
              ? await allowanceSufficient(wallet, permission)
              : null,
        };
      }),
    );
    const accountWallet = wallets.rows.find((row) => row.card_id === null);
    const merchant = merchants.rows[0];
    return {
      account: { id: a.id, verified: a.verified, role: a.role },
      wallet:
        a.role === "customer"
          ? cards.length === 1
            ? cards[0]!.wallet
            : null
          : await readWallet(
              accountWallet ??
                (merchant
                  ? { address: merchant.recipient, status: "ready" }
                  : null),
            ),
      card: {
        linked: cards.some((card) => card.status === "active"),
        last4: cards.find((card) => card.status === "active")?.last4 ?? null,
      },
      cards,
      policy:
        a.role === "customer" && cards.length === 1 ? cards[0]!.policy : null,
      unassignedWalletAvailable:
        a.role === "customer" && accountWallet?.status === "ready",
      payments: payments.rows.map((row) => ({
        id: row.id,
        cardId: row.card_id ?? null,
        merchantName: row.merchant_name,
        amount: row.amount,
        grossAmount: row.gross_amount ?? row.amount,
        discountAmount: row.discount_amount ?? "0",
        rewardId: row.reward_id ?? null,
        symbol: config.TOKEN_SYMBOL,
        name: config.TOKEN_NAME,
        onchainSymbol: config.TOKEN_ONCHAIN_SYMBOL,
        decimals: config.TOKEN_DECIMALS,
        status: invoice(row).status,
        createdAt: row.created_at.toISOString(),
        errorCode: row.error_code ?? null,
        txHash: row.tx_hash,
        explorerUrl: explorer(row.tx_hash),
      })),
      merchant: merchant
        ? {
            id: merchant.id,
            name: merchant.name,
            recipient: merchant.recipient,
            confirmedCount: merchant.confirmed_count,
            receivedTotal: merchant.received_total,
          }
        : null,
    };
  });
  async function funding(
    req: import("fastify").FastifyRequest,
    cardId?: string,
  ) {
    const account = await authenticate(req);
    if (cardId) {
      customer(account);
      await resolveCard(account.id, cardId);
    }
    const wallets = (
      await pool.query(
        "SELECT address,card_id FROM wallets WHERE account_id=$1 AND status='ready' AND ($2::uuid IS NULL OR card_id=$2)",
        [account.id, cardId ?? null],
      )
    ).rows;
    if (!hasPayments || wallets.length === 0)
      return {
        status: "pending_setup",
        historyComplete: false,
        historyStatus: "unavailable",
        transfers: null,
        source: "multibaas",
        symbol: config.TOKEN_SYMBOL,
        name: config.TOKEN_NAME,
        onchainSymbol: config.TOKEN_ONCHAIN_SYMBOL,
        limit: 100,
      };
    const results = await Promise.all(
      wallets.map((wallet) =>
        readFunding(
          wallet.address,
          account.id,
          account.merchant_id,
          wallet.card_id,
        ),
      ),
    );
    if (results.some((result) => result.status !== "available"))
      return {
        status: "unavailable",
        historyComplete: false,
        historyStatus: "unavailable",
        transfers: null,
        source: "multibaas",
        symbol: config.TOKEN_SYMBOL,
        name: config.TOKEN_NAME,
        onchainSymbol: config.TOKEN_ONCHAIN_SYMBOL,
        limit: 100,
      };
    const transfers = results
      .flatMap((result) => result.transfers ?? [])
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 100);
    const historyComplete =
      results.every((r) => r.historyComplete === true) &&
      results.reduce((sum, r) => sum + (r.transfers?.length ?? 0), 0) <= 100;
    return {
      status: "available",
      transfers,
      source: "multibaas",
      symbol: config.TOKEN_SYMBOL,
      name: config.TOKEN_NAME,
      onchainSymbol: config.TOKEN_ONCHAIN_SYMBOL,
      limit: 100,
      historyComplete,
      historyStatus: historyComplete ? "complete" : "partial",
    };
  }
  app.get("/v1/funding", (req) => funding(req));
  app.get("/v1/cards/:cardId/funding", (req) =>
    funding(req, z.object({ cardId: z.uuid() }).parse(req.params).cardId),
  );
  app.post("/v1/wallet", async (req) => {
    const a = await authenticate(req);
    customer(a);
    const body = z
      .object({ cardId: z.uuid().optional() })
      .strict()
      .parse(req.body ?? {});
    const card = await resolveCard(a.id, body.cardId);
    const inserted = await transaction(async (db) => {
      await db.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [a.id]);
      await resolveCard(a.id, card.id, db);
      const existing = (
        await db.query(
          "SELECT * FROM wallets WHERE account_id=$1 AND card_id=$2",
          [a.id, card.id],
        )
      ).rows[0];
      if (existing) return { existing: true, row: existing };
      const row = (
        await db.query(
          "INSERT INTO wallets(account_id,card_id,key_name,status) VALUES($1,$2,$3,'provisioning') RETURNING *",
          [a.id, card.id, `suica-card-${card.id}-${randomUUID()}`],
        )
      ).rows[0];
      return { existing: false, row };
    });
    if (inserted.existing) {
      if (inserted.row.provider !== "aws_kms") requireAwsWallet(inserted.row);
      return {
        address: inserted.row.address,
        status:
          inserted.row.status === "queued"
            ? "provisioning"
            : inserted.row.status,
      };
    }
    try {
      const wallet = await (
        await kmsWallets()
      ).createWallet(inserted.row.key_name);
      await pool.query(
        "UPDATE wallets SET address=$2,key_id=$3,status='ready' WHERE id=$1",
        [inserted.row.id, wallet.address.toLowerCase(), wallet.keyId],
      );
      return { address: wallet.address.toLowerCase(), status: "ready" };
    } catch (error) {
      await pool.query(
        "UPDATE wallets SET status='needs_attention' WHERE id=$1",
        [inserted.row.id],
      );
      throw error;
    }
  });
  app.post("/v1/wallet/claim", async (req) => {
    const a = await authenticate(req);
    customer(a);
    const { cardId } = z.object({ cardId: z.uuid() }).strict().parse(req.body);
    return transaction(async (db) => {
      await db.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [a.id]);
      await resolveCard(a.id, cardId, db);
      const legacy = (
        await db.query(
          "SELECT * FROM wallets WHERE account_id=$1 AND card_id IS NULL FOR UPDATE",
          [a.id],
        )
      ).rows[0];
      const existing = (
        await db.query(
          "SELECT * FROM wallets WHERE account_id=$1 AND card_id=$2 FOR UPDATE",
          [a.id, cardId],
        )
      ).rows[0];
      if (!legacy && existing?.status === "ready") {
        const claimed = await db.query(
          "SELECT 1 FROM audit_events WHERE account_id=$1 AND reference=$2 AND event='legacy_wallet_assigned'",
          [a.id, cardId],
        );
        if (claimed.rowCount)
          return { address: existing.address, status: existing.status };
      }
      if (!legacy || legacy.status !== "ready")
        throw new AppError(
          "wallet_unavailable",
          "No existing wallet is available.",
          409,
        );
      requireAwsWallet(legacy);
      if (existing)
        throw new AppError(
          "card_has_wallet",
          "This card already has its own wallet.",
          409,
        );
      const pending = await db.query(
        "SELECT 1 FROM payment_jobs WHERE account_id=$1 AND (wallet_id=$2 OR wallet_id IS NULL) AND status IN ('queued','submitting','pending','reconciling') UNION ALL SELECT 1 FROM operator_transactions WHERE address=$3 AND status IN ('signed','pending','reconciling') LIMIT 1",
        [a.id, legacy.id, legacy.address],
      );
      if (pending.rowCount)
        throw new AppError(
          "wallet_operation_pending",
          "Wait for pending wallet operations before assigning it.",
          409,
        );
      await db.query("UPDATE wallets SET card_id=$2 WHERE id=$1", [
        legacy.id,
        cardId,
      ]);
      await db.query(
        "UPDATE policies SET card_id=$2,enabled=false WHERE account_id=$1 AND card_id IS NULL",
        [a.id, cardId],
      );
      await db.query(
        "INSERT INTO audit_events(account_id,event,reference) VALUES($1,'legacy_wallet_assigned',$2)",
        [a.id, cardId],
      );
      return { address: legacy.address, status: legacy.status };
    });
  });
  app.post("/v1/wallet/allowance", async (req) => {
    const a = await authenticate(req);
    customer(a);
    const { amount, requestId, cardId, router } = z
      .object({
        amount: amountSchema,
        requestId: z.uuid().optional(),
        cardId: z.uuid().optional(),
        router: z
          .enum(["legacy", "rewards", "collectibles", "loyalty"])
          .optional(),
      })
      .parse(req.body);
    await multibaas.validateChain();
    const card = await resolveCard(a.id, cardId, pool, true);
    return requestAllowance(a.id, amount, requestId, card.id, router);
  });
  app.get("/v1/jobs/:id", async (req) => {
    const a = await authenticate(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const row = (
      await pool.query(
        "SELECT * FROM payment_jobs WHERE id=$1 AND account_id=$2",
        [id, a.id],
      )
    ).rows[0];
    if (!row) throw new AppError("not_found", "Operation not found.", 404);
    return {
      id: row.id,
      status: row.status,
      txHash: row.tx_hash,
      explorerUrl: explorer(row.tx_hash),
      errorCode: row.error_code,
    };
  });
  app.put("/v1/policy", async (req) => {
    const a = await authenticate(req);
    customer(a);
    const body = z
      .object({
        enabled: z.boolean(),
        cardId: z.uuid().optional(),
        perPaymentLimit: amountSchema,
        totalLimit: amountSchema,
        expiresAt: z.iso.datetime(),
        merchantScope: z.enum(["selected", "all"]).default("selected"),
        merchantIds: z.array(z.uuid()).max(100).default([]),
        useRewards: z.boolean().default(false),
        maxPointsPerPayment: wholePointsSchema.nullable().default(null),
        router: z
          .enum(["legacy", "rewards", "collectibles", "loyalty"])
          .optional(),
      })
      .parse(req.body);
    if (
      (body.merchantScope === "all" && body.merchantIds.length !== 0) ||
      (body.merchantScope === "selected" && body.merchantIds.length === 0)
    )
      throw new AppError(
        "invalid_merchant_scope",
        "Choose all participating merchants or provide selected merchants.",
      );
    const router = paymentRouter(body.router);
    if (body.useRewards && router.kind === "legacy")
      throw new AppError(
        "reward_permission_required",
        "Choose the rewards payment router before enabling reward redemption.",
        409,
      );
    const card = await resolveCard(a.id, body.cardId, pool, body.enabled);
    if (
      BigInt(body.perPaymentLimit) > BigInt(body.totalLimit) ||
      Date.parse(body.expiresAt) <= Date.now()
    )
      throw new AppError(
        "invalid_policy",
        "Choose valid limits and a future expiration.",
      );
    if (body.enabled) {
      await multibaas.validateChain();
      const wallet = (
        await pool.query(
          `SELECT w.address,w.provider,w.key_id,COALESCE(p.spent,0)::text AS spent FROM wallets w LEFT JOIN policies p ON p.card_id=w.card_id WHERE w.account_id=$1 AND w.card_id=$2 AND w.status='ready'`,
          [a.id, card.id],
        )
      ).rows[0];
      if (!wallet)
        throw new AppError(
          "wallet_required",
          "Create and fund your wallet first.",
          409,
        );
      requireAwsWallet(wallet);
      if (
        BigInt(await multibaas.allowance(wallet.address, router.address)) <
        remainingPolicyAllowance(body.totalLimit, wallet.spent)
      )
        throw new AppError(
          "allowance_required",
          "Approve the spending allowance and wait for confirmation first.",
          409,
        );
    }
    return transaction(async (db) => {
      // Serialize policy edits with authorisations; existing spent/reserved are NEVER reset by editing limits.
      await db.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [a.id]);
      await resolveCard(a.id, card.id, db, body.enabled);
      const merchants = await db.query(
        "SELECT id FROM merchants WHERE id=ANY($1::uuid[]) AND enabled",
        [body.merchantIds],
      );
      if (merchants.rows.length !== new Set(body.merchantIds).size)
        throw new AppError(
          "invalid_merchant",
          "An allowed merchant is unavailable.",
        );
      const current = (
        await db.query(
          "SELECT * FROM policies WHERE account_id=$1 AND card_id=$2 FOR UPDATE",
          [a.id, card.id],
        )
      ).rows[0];
      if (
        current &&
        BigInt(current.spent) + BigInt(current.reserved) >
          BigInt(body.totalLimit)
      )
        throw new AppError(
          "committed_budget",
          "The limit is below completed and pending payments.",
          409,
        );
      const { rows } = await db.query(
        `INSERT INTO policies(account_id,enabled,per_payment_limit,total_limit,expires_at,card_id,router_address,router_label,use_rewards,merchant_scope,max_points_per_payment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(card_id) WHERE card_id IS NOT NULL DO UPDATE SET enabled=$2,per_payment_limit=$3,total_limit=$4,expires_at=$5,router_address=$7,router_label=$8,use_rewards=$9,merchant_scope=$10,max_points_per_payment=$11,consent_at=now() RETURNING *`,
        [
          a.id,
          body.enabled,
          body.perPaymentLimit,
          body.totalLimit,
          body.expiresAt,
          card.id,
          router.address,
          router.label,
          body.useRewards,
          body.merchantScope,
          body.maxPointsPerPayment,
        ],
      );
      if (body.enabled)
        await db.query(
          "INSERT INTO policy_router_consents(policy_id,router_address,router_label)VALUES($1,$2,$3) ON CONFLICT(policy_id,router_address) DO UPDATE SET router_label=excluded.router_label,consented_at=now()",
          [rows[0].id, router.address, router.label],
        );
      await db.query("DELETE FROM policy_merchants WHERE policy_id=$1", [
        rows[0].id,
      ]);
      for (const id of new Set(body.merchantIds))
        await db.query(
          "INSERT INTO policy_merchants(account_id,merchant_id,policy_id) VALUES($1,$2,$3)",
          [a.id, id, rows[0].id],
        );
      return policy({
        ...rows[0],
        merchant_ids: [...new Set(body.merchantIds)],
      });
    });
  });
  app.post("/v1/freeze", async (req) => {
    const a = await authenticate(req);
    customer(a);
    const { cardId } = z
      .object({ cardId: z.uuid().optional() })
      .strict()
      .parse(req.body ?? {});
    if (cardId) await resolveCard(a.id, cardId);
    await pool.query(
      "UPDATE policies SET enabled=false WHERE account_id=$1 AND ($2::uuid IS NULL OR card_id=$2)",
      [a.id, cardId ?? null],
    );
    return { enabled: false };
  });
  app.post("/v1/terminals", async (req) => {
    const a = await authenticate(req);
    const mid = merchant(a);
    const body = z
      .object({
        publicKey: z.string().max(1000),
        name: z.string().min(1).max(80),
      })
      .parse(req.body);
    try {
      publicKey(body.publicKey);
    } catch {
      throw new AppError(
        "invalid_key",
        "A DER-encoded P-256 public key is required.",
      );
    }
    const id = randomUUID();
    const inserted = await pool.query(
      "INSERT INTO terminals(id,merchant_id,public_key,name) SELECT $1,id,$3,$4 FROM merchants WHERE id=$2 AND enabled",
      [id, mid, body.publicKey, body.name],
    );
    if (!inserted.rowCount)
      throw new AppError(
        "merchant_disabled",
        "This merchant is disabled.",
        403,
      );
    return { id, merchantId: mid };
  });
  app.get("/v1/terminals/:id", async (req) => {
    const mid = merchant(await authenticate(req));
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const row = (
      await pool.query(
        "SELECT id,merchant_id,public_key,revoked_at FROM terminals WHERE id=$1 AND merchant_id=$2",
        [id, mid],
      )
    ).rows[0];
    if (!row)
      throw new AppError(
        "not_found",
        "This terminal is not available for your merchant.",
        404,
      );
    return {
      id: row.id,
      merchantId: row.merchant_id,
      publicKey: row.public_key,
      active: row.revoked_at === null,
    };
  });
  app.delete("/v1/terminals/:id", async (req) => {
    const mid = merchant(await authenticate(req));
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await pool.query(
      "UPDATE terminals SET revoked_at=now() WHERE id=$1 AND merchant_id=$2",
      [id, mid],
    );
    return { revoked: true };
  });
  app.post("/v1/invoices", async (req) => {
    const mid = merchant(await authenticate(req));
    const body = z
      .object({
        amount: amountSchema,
        description: z.string().max(200).optional(),
        useReward: z.boolean().default(false),
        router: z.enum(["loyalty", "collectibles", "rewards"]).optional(),
        maxPoints: wholePointsSchema.nullable().default(null),
        requestId: z.uuid().optional(),
      })
      .parse(req.body);
    await multibaas.validateChain();
    return invoice(
      await requestInvoice(
        mid,
        body.amount,
        body.description ?? "",
        body.requestId,
        body.useReward,
        body.router,
        body.maxPoints,
      ),
    );
  });
  app.get("/v1/invoices/:id", async (req) => {
    const a = await authenticate(req);
    const { id } = invoiceParams.parse(req.params);
    const { rows } = await pool.query(
      `SELECT i.*,j.tx_hash,j.error_code FROM invoices i LEFT JOIN payment_jobs j ON j.invoice_id=i.id WHERE i.id=$1 AND (i.merchant_id=$2 OR i.account_id=$3)`,
      [id, a.merchant_id, a.id],
    );
    if (!rows[0]) throw new AppError("not_found", "Invoice not found.", 404);
    const refund = await readRefundByInvoice(id);
    return {
      ...invoice(rows[0]),
      refundEligible:
        rows[0].reward_model === "points" &&
        rows[0].status === "confirmed" &&
        (!refund || refund.status === "failed"),
      refund,
    };
  });
  app.post("/v1/invoices/:id/cancel", async (req) => {
    const mid = merchant(await authenticate(req));
    const { id } = invoiceParams.parse(req.params);
    const result = await pool.query(
      `UPDATE invoices SET status='cancelled' WHERE id=$1 AND merchant_id=$2 AND status='awaiting_tap' RETURNING id`,
      [id, mid],
    );
    if (!result.rows[0])
      throw new AppError(
        "cannot_cancel",
        "This invoice cannot be cancelled.",
        409,
      );
    return { id, status: "cancelled" };
  });
  app.post("/v1/invoices/:id/challenge", async (req) => {
    const mid = merchant(await authenticate(req));
    const { id } = invoiceParams.parse(req.params);
    const { terminalId } = z.object({ terminalId: z.uuid() }).parse(req.body);
    const { rows } = await pool.query(
      `SELECT i.expires_at FROM invoices i JOIN terminals t ON t.merchant_id=i.merchant_id JOIN merchants m ON m.id=i.merchant_id WHERE i.id=$1 AND i.merchant_id=$2 AND t.id=$3 AND t.revoked_at IS NULL AND m.enabled AND i.status='awaiting_tap' AND i.expires_at>now()`,
      [id, mid, terminalId],
    );
    if (!rows[0])
      throw new AppError(
        "invoice_unavailable",
        "Invoice or terminal is unavailable.",
        409,
      );
    const challenge = randomToken();
    const expiresAt = new Date(
      Math.min(Date.now() + 60000, rows[0].expires_at.getTime()),
    ).toISOString();
    await pool.query(
      "INSERT INTO challenges(challenge_hash,invoice_id,terminal_id,expires_at) VALUES($1,$2,$3,$4)",
      [hash(challenge), id, terminalId, expiresAt],
    );
    return { challenge, expiresAt };
  });
  app.post("/v1/scans", async (req) => {
    const a = await authenticate(req);
    const mid = merchant(a);
    const { payload, signature } = z
      .object({ payload: scanSchema, signature: z.string().min(60).max(200) })
      .parse(req.body);
    return transaction(async (db) => {
      const { rows } = await db.query(
        `SELECT i.*,c.expires_at challenge_expires,c.consumed_at,t.public_key FROM invoices i JOIN challenges c ON c.invoice_id=i.id JOIN terminals t ON t.id=c.terminal_id JOIN merchants m ON m.id=i.merchant_id WHERE i.id=$1 AND i.merchant_id=$2 AND c.challenge_hash=$3 AND t.id=$4 AND t.merchant_id=i.merchant_id AND t.revoked_at IS NULL AND m.enabled FOR UPDATE OF i,c`,
        [payload.invoiceId, mid, hash(payload.challenge), payload.terminalId],
      );
      const row = rows[0];
      if (!row)
        throw new AppError(
          "invalid_challenge",
          "The terminal or challenge is invalid.",
          403,
        );
      if (row.consumed_at)
        throw new AppError(
          "replayed_scan",
          "This scan challenge was already used.",
          409,
        );
      if (
        row.status !== "awaiting_tap" ||
        row.expires_at.getTime() <= Date.now() ||
        row.challenge_expires.getTime() <= Date.now()
      )
        throw new AppError(
          "invoice_expired",
          "This invoice or challenge is no longer payable.",
          409,
        );
      if (
        payload.chainId !== row.chain_id ||
        payload.token !== row.token ||
        payload.amount !== (row.gross_amount ?? row.amount) ||
        payload.version !== (row.scan_version ?? 1) ||
        ((payload.version === 2 || payload.version === 3) &&
          (payload.routerAddress !== row.router_address ||
            payload.useReward !== row.use_reward)) ||
        (payload.version === 3 && payload.maxPoints !== row.max_points) ||
        payload.expiresAt !== row.challenge_expires.toISOString() ||
        !verifyScan(payload, signature, row.public_key)
      )
        throw new AppError(
          "invalid_scan",
          "The signed scan does not match the invoice.",
          403,
        );
      const card = (
        await db.query(
          `SELECT c.id card_id,c.account_id,c.linked_at::text card_linked_at FROM cards c JOIN accounts a ON a.id=c.account_id WHERE c.card_hash=$1 AND c.active AND a.verified`,
          [cardHash(payload.cardId, config.CARD_HMAC_SECRET)],
        )
      ).rows[0];
      if (!card)
        throw new AppError(
          "unknown_card",
          "This card is not linked to an eligible account.",
          404,
        );
      await db.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
        card.account_id,
      ]);
      // A freeze/removal may have committed while this scan waited for the account lock.
      const stillLinked = await db.query(
        "SELECT 1 FROM cards WHERE card_hash=$1 AND account_id=$2 AND active AND removed_at IS NULL AND linked_at=$3::timestamptz FOR UPDATE",
        [
          cardHash(payload.cardId, config.CARD_HMAC_SECRET),
          card.account_id,
          card.card_linked_at,
        ],
      );
      if (!stillLinked.rowCount)
        throw new AppError(
          "unknown_card",
          "This card is frozen or no longer linked.",
          409,
        );
      const p = (
        await db.query(
          `SELECT p.*,(p.merchant_scope='all' OR EXISTS(SELECT 1 FROM policy_merchants pm WHERE pm.policy_id=p.id AND pm.merchant_id=$2)) merchant_allowed FROM policies p WHERE p.account_id=$1 AND p.card_id=$3 FOR UPDATE OF p`,
          [card.account_id, mid, card.card_id],
        )
      ).rows[0];
      if (!p || !p.enabled || p.expires_at.getTime() <= Date.now())
        throw new AppError(
          "spending_disabled",
          "Automatic payment is disabled or expired.",
          403,
        );
      const router = routerSnapshot(row.router_address, row.router_label);
      if (
        !(await allowsPolicyRouter(
          db,
          p,
          router.address,
          Boolean(row.use_reward),
        ))
      )
        throw new AppError(
          "router_approval_required",
          "The customer must approve and enable this payment router before tapping.",
          403,
        );
      if (row.use_reward && router.kind !== "loyalty" && !p.use_rewards)
        throw new AppError(
          "reward_permission_required",
          "The customer has not enabled automatic reward redemption.",
          403,
        );
      if (!p.merchant_allowed)
        throw new AppError(
          "merchant_not_allowed",
          "The customer has not saved spending permission for this merchant. Ask them to enable it in Spending permission.",
          403,
        );
      if (BigInt(row.gross_amount ?? row.amount) > BigInt(p.per_payment_limit))
        throw new AppError(
          "spending_limit",
          "The gross purchase exceeds the per-payment limit.",
          403,
        );
      const w = (
        await db.query(
          `SELECT w.id,w.address,w.provider,w.key_id,w.card_id,COALESCE(p.spent,0)::text AS spent FROM wallets w LEFT JOIN policies p ON p.card_id=w.card_id WHERE w.account_id=$1 AND w.card_id=$2 AND w.status='ready'`,
          [card.account_id, card.card_id],
        )
      ).rows[0];
      if (!w)
        throw new AppError(
          "wallet_required",
          "The linked wallet is unavailable.",
          409,
        );
      requireAwsWallet(w);
      const jobId = randomUUID();
      const gross = row.gross_amount ?? row.amount;
      const quoted = row.use_reward
        ? router.kind === "loyalty"
          ? await choosePoints(
              db,
              w,
              mid,
              gross,
              row.max_points ?? null,
              p.use_rewards ? (p.max_points_per_payment ?? null) : "0",
            )
          : await chooseReward(
              db,
              w,
              mid,
              gross,
              jobId,
              router.kind === "collectibles" ? "collectibles" : "rewards",
            )
        : { rewardId: null, discountAmount: "0", netAmount: gross };
      if (
        !(await validateRetainedAllowance(
          p,
          w.address,
          router.address,
          quoted.netAmount,
        ))
      )
        throw new AppError(
          "router_approval_required",
          "The earlier voucher router needs a retained spending allowance.",
          403,
        );
      const pointsRedeemed =
        "pointsRedeemed" in quoted ? quoted.pointsRedeemed : "0";
      if (
        !withinBudget(
          quoted.netAmount,
          p.per_payment_limit,
          p.total_limit,
          p.spent,
          p.reserved,
          (router.kind === "collectibles" && Boolean(quoted.rewardId)) ||
            (router.kind === "loyalty" && BigInt(pointsRedeemed) > 0n),
        )
      )
        throw new AppError(
          "spending_limit",
          "The actual charge exceeds the spending budget.",
          403,
        );

      await db.query(
        "UPDATE challenges SET consumed_at=now() WHERE challenge_hash=$1",
        [hash(payload.challenge)],
      );
      await db.query("UPDATE policies SET reserved=reserved+$2 WHERE id=$1", [
        p.id,
        quoted.netAmount,
      ]);
      await db.query(
        `UPDATE invoices SET account_id=$2,status='authorised',amount=$3,discount_amount=$4,reward_id=$5,points_redeemed=$6 WHERE id=$1`,
        [
          row.id,
          card.account_id,
          quoted.netAmount,
          quoted.discountAmount,
          quoted.rewardId,
          pointsRedeemed,
        ],
      );
      await db.query(
        `INSERT INTO payment_jobs(id,invoice_id,account_id,kind,amount,terminal_id,card_hash,expected_chain,expected_token,expected_router,card_linked_at,wallet_id,policy_id,card_id,expected_router_label,gross_amount,discount_amount,reward_id,reward_model,reward_credit_before,points_redeemed,max_points) VALUES($1,$2,$3,'payment',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [
          jobId,
          row.id,
          card.account_id,
          quoted.netAmount,
          payload.terminalId,
          cardHash(payload.cardId, config.CARD_HMAC_SECRET),
          row.chain_id,
          row.token,
          router.address,
          card.card_linked_at,
          w.id,
          p.id,
          card.card_id,
          router.label,
          gross,
          quoted.discountAmount,
          quoted.rewardId,
          router.kind === "loyalty"
            ? "points"
            : router.kind === "collectibles"
              ? "credit"
              : "percentage",
          "creditBefore" in quoted ? quoted.creditBefore : null,
          pointsRedeemed,
          row.max_points ?? null,
        ],
      );
      if (BigInt(pointsRedeemed) > 0n)
        await reservePoints(
          db,
          w.id,
          mid,
          jobId,
          pointsRedeemed,
          router.address,
        );
      if (quoted.rewardId)
        await reserveReward(db, router.address, quoted.rewardId, w.id, jobId);
      await db.query(
        "INSERT INTO audit_events(account_id,event,reference) VALUES($1,$2,$3)",
        [a.id, "scan_authorised", row.id],
      );
      return { invoiceId: row.id, status: "authorised" };
    }).catch(async (err) => {
      await pool.query(
        "INSERT INTO audit_events(account_id,event,reference) VALUES($1,$2,$3)",
        [
          a.id,
          `scan_rejected:${err instanceof AppError ? err.code : "validation_error"}`,
          payload.invoiceId,
        ],
      );
      throw err;
    });
  });
}

async function readFunding(
  address: string,
  accountId: string,
  merchantId: string | null,
  cardId: string | null,
) {
  try {
    await multibaas.validateTokenReadChain();
    const reads = await Promise.allSettled([
      multibaas.incomingTransfers(address),
      ...(hasFundingHistory
        ? [historicalMultibaas.incomingTransfers(address)]
        : []),
    ]);
    const claims = (
      await pool.query(
        "SELECT tx_hash FROM test_funding_claims WHERE account_id=$1 AND wallet_address=$2 AND chain_id=$3 AND token_address=$4 AND status='confirmed' AND tx_hash IS NOT NULL",
        [accountId, address, config.CHAIN_ID, config.TOKEN_ADDRESS],
      )
    ).rows;
    let result;
    try {
      result = mergeFundingSources(reads[0]!, reads[1]);
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        error.code !== "funding_sources_unavailable" ||
        !claims.length
      )
        throw error;
      result = {
        rows: [],
        historyComplete: false,
        historyStatus: "partial" as const,
      };
    }
    const excluded = new Set(
      (
        await pool.query(
          "SELECT r.tx_hash FROM receipts r JOIN invoices i ON i.id=r.invoice_id WHERE i.account_id=$1 OR i.merchant_id=$2",
          [accountId, merchantId],
        )
      ).rows.map((r) => r.tx_hash.toLowerCase()),
    );
    const transfers = [];
    const head = await multibaas.head();
    const uniqueRows = [
      ...new Map<string, any>(
        [...result.rows, ...claims.map((row) => ({ txHash: row.tx_hash }))].map(
          (row: any) => [String(row.txHash).toLowerCase(), row],
        ),
      ).values(),
    ];
    for (const row of uniqueRows) {
      if (excluded.has(String(row.txHash).toLowerCase())) continue;
      // Confirm the incoming transfer from raw receipt logs instead of trusting indexer display values.
      const receipt = await multibaas.receipt(row.txHash);
      const data = receipt.data;
      if (!data || BigInt(data.status) !== 1n) continue;
      if (
        String(data.transactionHash).toLowerCase() !==
        String(row.txHash).toLowerCase()
      )
        throw new AppError(
          "invalid_funding_receipt",
          "Funding receipt hash does not match the indexed transaction.",
          502,
        );
      const block = await multibaas.block(data.blockNumber);
      if (block.hash !== data.blockHash) continue;
      if (
        !Number.isSafeInteger(Number(block.timestamp)) ||
        Number(block.timestamp) < 0
      )
        throw new AppError(
          "invalid_block_timestamp",
          "Funding block timestamp is invalid.",
          502,
        );
      const createdAt = new Date(Number(block.timestamp) * 1000).toISOString();
      if (
        BigInt(head.number) - BigInt(data.blockNumber) + 1n <
        BigInt(config.CONFIRMATIONS)
      )
        continue;
      const transferInterface = new (await import("ethers")).Interface([
        "event Transfer(address indexed from,address indexed to,uint256 value)",
      ]);
      // Never classify any router payment transaction as wallet funding, even before the worker has stored its receipt.
      if (
        data.logs.some((log: any) =>
          [
            config.PAYMENT_ADDRESS,
            config.REWARD_PAYMENT_ADDRESS,
            config.COLLECTIBLE_PAYMENT_ADDRESS,
            config.LOYALTY_PAYMENT_ADDRESS,
          ].includes(String(log.address).toLowerCase()),
        )
      )
        continue;
      for (const log of data.logs) {
        if (
          log.removed ||
          String(log.address).toLowerCase() !== config.TOKEN_ADDRESS
        )
          continue;
        let decoded;
        try {
          decoded = transferInterface.parseLog(log);
        } catch {
          continue;
        }
        if (decoded && String(decoded.args.to).toLowerCase() === address)
          transfers.push({
            cardId,
            id: `${row.txHash}:${log.logIndex}`,
            from: String(decoded.args.from).toLowerCase(),
            amount: decoded.args.value.toString(),
            symbol: config.TOKEN_SYMBOL,
            name: config.TOKEN_NAME,
            onchainSymbol: config.TOKEN_ONCHAIN_SYMBOL,
            decimals: config.TOKEN_DECIMALS,
            createdAt,
            txHash: row.txHash,
            explorerUrl: explorer(row.txHash),
            status: "confirmed",
          });
      }
    }
    return {
      status: "available",
      historyComplete: result.historyComplete,
      historyStatus: result.historyStatus,
      transfers: [...new Map(transfers.map((t) => [t.id, t])).values()],
      source: "multibaas",
      symbol: config.TOKEN_SYMBOL,
      name: config.TOKEN_NAME,
      onchainSymbol: config.TOKEN_ONCHAIN_SYMBOL,
      limit: 100,
    };
  } catch {
    return {
      status: "unavailable",
      historyComplete: false,
      historyStatus: "unavailable",
      transfers: null,
      source: "multibaas",
      symbol: config.TOKEN_SYMBOL,
      name: config.TOKEN_NAME,
      onchainSymbol: config.TOKEN_ONCHAIN_SYMBOL,
      limit: 100,
    };
  }
}
