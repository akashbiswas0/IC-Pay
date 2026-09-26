import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, bearer, createAccount, type Account } from "./auth.js";
import { config, hasWorld } from "./config.js";
import { pool, transaction } from "./db.js";
import { AppError } from "./errors.js";
import { queueCardWallet } from "./card-wallet-provisioning.js";
import { applyVerifiedCardLink, prepareCardLink } from "./cards.js";
import {
  cardSchema,
  cardHash,
  hash,
  randomToken,
  signWorldRequest,
} from "./protocol.js";
const params = z.object({ id: z.uuid() });
function context(row: any, session: string | null) {
  return {
    id: row.id,
    purpose: row.purpose,
    replacesCardId: row.replaces_card_id ?? null,
    appId: config.WORLD_APP_ID,
    environment: config.WORLD_ENVIRONMENT,
    sessionId: session,
    rpContext: row.rp_context,
  };
}

/** Post-verification state transition. Caller must hold the request/account locks and
 * have verified the complete proof with World. Recovery grants access, never card linkage. */
export async function finalizeVerifiedWorldRequest(
  db: PoolClient,
  row: any,
  verifiedSessionId: string,
) {
  if (!["login", "recovery"].includes(row.purpose)) {
    const linkedCardId = await applyVerifiedCardLink(db, row);
    if (row.purpose === "enrollment")
      await db.query(
        "UPDATE accounts SET verified=true,world_session=$2 WHERE id=$1",
        [row.account_id, verifiedSessionId],
      );
    await queueCardWallet(db, row.account_id, linkedCardId);
  }
  await db.query("UPDATE world_requests SET consumed_at=now() WHERE id=$1", [
    row.id,
  ]);
  await db.query(
    "INSERT INTO audit_events(account_id,event,reference) VALUES($1,$2,$3)",
    [row.account_id, `world_${row.purpose}`, row.id],
  );
}
async function requestOwner(req: FastifyRequest, id: string) {
  const token = hash(bearer(req));
  const { rows } = await pool.query(
    `SELECT r.*,a.world_session FROM world_requests r JOIN accounts a ON a.id=r.account_id WHERE r.id=$1 AND (r.handoff_hash=$2 OR EXISTS (SELECT 1 FROM sessions s WHERE s.account_id=r.account_id AND s.token_hash=$2 AND s.expires_at>now() AND s.revoked_at IS NULL))`,
    [id, token],
  );
  const row = rows[0];
  if (!row)
    throw new AppError("not_found", "Verification request not found.", 404);
  if (row.expires_at.getTime() <= Date.now())
    throw new AppError(
      "verification_expired",
      "Start a fresh World verification.",
      410,
    );
  return row;
}
export async function beginWorldRequest(
  account: Pick<Account, "id" | "world_session">,
  purpose: "enrollment" | "addition" | "replacement" | "login" | "recovery",
  cardId: string,
  exchangeSecret?: string,
  replacesCardId?: string,
) {
  if (!hasWorld)
    throw new AppError(
      "world_unconfigured",
      "World verification is not configured.",
      503,
    );
  const signature = await signWorldRequest(config.WORLD_SIGNING_KEY!);
  const rpContext = { rp_id: config.WORLD_RP_ID!, ...signature };
  const id = randomUUID();
  const handoffToken = randomToken();
  const hashedCard = cardHash(cardId, config.CARD_HMAC_SECRET);
  const row = await transaction(async (db) => {
    const target =
      purpose === "login" || purpose === "recovery"
        ? { id: null, generation: null }
        : await prepareCardLink(
            db,
            account.id,
            purpose,
            hashedCard,
            replacesCardId,
          );
    const { rows } = await db.query(
      `INSERT INTO world_requests(id,account_id,purpose,nonce,card_hash,card_last4,expires_at,rp_context,handoff_hash,exchange_hash,replaces_card_id,replaces_card_linked_at) VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7),$8,$9,$10,$11,$12) RETURNING *`,
      [
        id,
        account.id,
        purpose,
        signature.nonce,
        hashedCard,
        cardId.slice(-4),
        signature.expires_at,
        JSON.stringify(rpContext),
        hash(handoffToken),
        exchangeSecret ? hash(exchangeSecret) : null,
        target.id,
        target.generation,
      ],
    );
    return rows[0];
  });
  return {
    ...context(row, account.world_session),
    handoffToken,
    expiresAt: row.expires_at.toISOString(),
  };
}
export async function worldRoutes(app: FastifyInstance) {
  app.post("/v1/enrollments", async (req) => {
    const { cardId } = z
      .object({ cardId: cardSchema })
      .strict()
      .parse(req.body);
    if (!hasWorld)
      throw new AppError(
        "world_unconfigured",
        "World verification is not configured.",
        503,
      );
    const existing = (
      await pool.query(
        "SELECT c.active,a.verified,a.role FROM cards c JOIN accounts a ON a.id=c.account_id WHERE c.card_hash=$1",
        [cardHash(cardId, config.CARD_HMAC_SECRET)],
      )
    ).rows[0];
    if (existing) {
      if (existing.verified && existing.role === "customer")
        throw new AppError(
          existing.active ? "card_sign_in_required" : "card_recovery_required",
          existing.active
            ? "This Suica already has an account. Sign in with World."
            : "Recover your existing account with this card and World.",
          409,
        );
      throw new AppError(
        "card_linked",
        "This Suica already belongs to an account.",
        409,
      );
    }
    return transaction((db) => createAccount(db));
  });
  app.post("/v1/world/requests", async (req) => {
    const account = await authenticate(req);
    const body = z
      .object({
        purpose: z.enum(["enrollment", "addition", "replacement"]),
        cardId: cardSchema,
        replacesCardId: z.uuid().optional(),
      })
      .strict()
      .parse(req.body);
    if (!hasWorld)
      throw new AppError(
        "world_unconfigured",
        "World verification is not configured.",
        503,
      );
    if (account.role !== "customer")
      throw new AppError(
        "customer_required",
        "Only customer accounts can link cards.",
        403,
      );
    if (
      (body.purpose === "enrollment" && account.verified) ||
      (body.purpose !== "enrollment" && !account.verified)
    )
      throw new AppError(
        "invalid_operation",
        "This verification operation is not available for this account.",
        409,
      );
    return beginWorldRequest(
      account,
      body.purpose,
      body.cardId,
      undefined,
      body.replacesCardId,
    );
  });
  app.get("/v1/world/requests/:id/context", async (req) => {
    const { id } = params.parse(req.params);
    const row = await requestOwner(req, id);
    if (row.consumed_at)
      throw new AppError(
        "verification_used",
        "This verification was already completed.",
        409,
      );
    return context(row, row.world_session);
  });
  app.get("/v1/world/requests/:id", async (req) => {
    const account = await authenticate(req);
    const { id } = params.parse(req.params);
    const { rows } = await pool.query(
      "SELECT * FROM world_requests WHERE id=$1 AND account_id=$2",
      [id, account.id],
    );
    if (!rows[0])
      throw new AppError("not_found", "Verification request not found.", 404);
    const row = rows[0];
    return {
      id,
      status: row.consumed_at
        ? "verified"
        : row.expires_at.getTime() <= Date.now()
          ? "expired"
          : "pending",
    };
  });
  app.post("/v1/world/requests/:id/cancel", async (req) => {
    const { id } = params.parse(req.params);
    const { exchangeSecret } = z
      .object({
        exchangeSecret: z
          .string()
          .regex(/^[A-Za-z0-9_-]{43}$/)
          .optional(),
      })
      .strict()
      .parse(req.body ?? {});
    const account = exchangeSecret ? null : await authenticate(req);
    return transaction(async (db) => {
      const row = (
        await db.query("SELECT * FROM world_requests WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      const permitted =
        row &&
        (["login", "recovery"].includes(row.purpose)
          ? Boolean(
              exchangeSecret && row.exchange_hash === hash(exchangeSecret),
            )
          : Boolean(account && account.id === row.account_id));
      if (!permitted)
        throw new AppError("not_found", "Verification request not found.", 404);
      // The same row lock protects verification. A completed proof is never undone.
      if (row.consumed_at) return { status: "verified" };
      await db.query(
        "UPDATE world_requests SET expires_at=LEAST(expires_at,now()) WHERE id=$1",
        [id],
      );
      await db.query(
        "INSERT INTO audit_events(account_id,event,reference) VALUES($1,'world_cancelled',$2)",
        [row.account_id, id],
      );
      return { status: "cancelled" };
    });
  });
  app.post("/v1/world/requests/:id/verify", async (req) => {
    const { id } = params.parse(req.params);
    await requestOwner(req, id);
    const { result } = z
      .object({ result: z.record(z.string(), z.unknown()) })
      .parse(req.body);
    return transaction(async (db) => {
      const { rows } = await db.query(
        `SELECT r.*,r.replaces_card_linked_at::text replaces_card_generation,a.world_session,a.verified FROM world_requests r JOIN accounts a ON a.id=r.account_id WHERE r.id=$1 FOR UPDATE OF r,a`,
        [id],
      );
      const row = rows[0];
      if (row.consumed_at || row.expires_at.getTime() <= Date.now())
        throw new AppError(
          "verification_used",
          "This verification is expired or already used.",
          409,
        );
      const proof = z
        .object({
          protocol_version: z.literal("4.0"),
          nonce: z.string(),
          session_id: z.string().regex(/^session_[a-fA-F0-9]{128}$/),
          environment: z.enum(["production", "staging"]).optional(),
          responses: z
            .array(
              z
                .object({
                  identifier: z.string(),
                  issuer_schema_id: z.literal(11),
                  session_nullifier: z.tuple([z.string(), z.string()]),
                  sybil_score: z.number().int(),
                  proof: z.array(z.string()).length(5),
                })
                .passthrough(),
            )
            .min(1),
          integrity_bundle: z.object({ version: z.literal(2) }).passthrough(),
        })
        .passthrough()
        .parse(result);
      if (
        proof.nonce !== row.nonce ||
        (proof.environment ?? "production") !== config.WORLD_ENVIRONMENT
      )
        throw new AppError(
          "proof_context_mismatch",
          "World proof does not match this request.",
          403,
        );
      if (
        row.purpose !== "enrollment" &&
        (!row.verified ||
          !row.world_session ||
          proof.session_id !== row.world_session)
      )
        throw new AppError(
          "session_mismatch",
          "Verification must use the account’s existing World session.",
          403,
        );
      if (row.purpose === "enrollment" && row.verified)
        throw new AppError(
          "already_verified",
          "This account is already verified.",
          409,
        );
      if (["login", "recovery"].includes(row.purpose)) {
        const linked = await db.query(
          "SELECT 1 FROM cards WHERE card_hash=$1 AND account_id=$2 AND ($3::boolean OR active)",
          [row.card_hash, row.account_id, row.purpose === "recovery"],
        );
        if (!linked.rowCount)
          throw new AppError(
            "sign_in_unavailable",
            "This sign-in could not be completed. Start again with your linked card.",
            403,
          );
      }
      if (
        config.WORLD_ENVIRONMENT === "staging" &&
        !config.WORLD_STAGING_VERIFICATION_TOKEN
      )
        throw new AppError(
          "world_staging_unconfigured",
          "Open a World staging verification window and configure its server token.",
          503,
        );
      const response = await fetch(
        `https://developer.world.org/api/v4/verify/${config.WORLD_RP_ID}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.WORLD_ENVIRONMENT === "staging"
              ? {
                  "x-staging-verification-token":
                    config.WORLD_STAGING_VERIFICATION_TOKEN!,
                }
              : {}),
          },
          body: JSON.stringify({ ...result, min_protocol_version: "4.0" }),
          signal: AbortSignal.timeout(20000),
        },
      );
      const verified = (await response.json()) as {
        success?: boolean;
        session_id?: string;
        environment?: string;
        results?: { identifier?: string; success?: boolean }[];
      };
      if (
        !response.ok ||
        verified.success !== true ||
        verified.session_id !== proof.session_id ||
        verified.environment !== config.WORLD_ENVIRONMENT ||
        !verified.results?.length ||
        verified.results.some((r) => r.success !== true) ||
        !verified.results.some((r) => r.identifier === "selfie")
      )
        throw new AppError(
          "world_verification_failed",
          "World could not verify this proof.",
          403,
        );
      for (const item of proof.responses)
        await db.query(
          "INSERT INTO world_proofs(nullifier,request_id) VALUES($1,$2)",
          [hash(JSON.stringify(item.session_nullifier)), id],
        );
      await finalizeVerifiedWorldRequest(db, row, proof.session_id);
      return { verified: true };
    });
  });
}
