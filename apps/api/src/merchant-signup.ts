import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, merchant } from "./auth.js";
import { config, hasPayments } from "./config.js";
import { pool, transaction } from "./db.js";
import { createInvitation } from "./device-auth.js";
import { AppError } from "./errors.js";
import { hash, publicKey } from "./protocol.js";

export async function merchantSignupRoutes(app: FastifyInstance) {
  app.post(
    "/v1/merchant/activate",
    {
      config: { rateLimit: { max: 10, timeWindow: "5 minutes" } },
    },
    async (req) => {
      const a = await authenticate(req);
      const merchantId = merchant(a);
      const body = z
        .object({
          code: z
            .string()
            .max(40)
            .transform((v) => v.toUpperCase().replace(/[\s-]/g, ""))
            .pipe(z.string().regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/)),
          publicKey: z.string().max(1000),
        })
        .strict()
        .parse(req.body);
      try {
        publicKey(body.publicKey);
      } catch {
        throw new AppError(
          "invalid_key",
          "A valid device signing key is required.",
        );
      }
      return transaction(async (db) => {
        const enabled = (
          await db.query(
            "SELECT id FROM merchants WHERE id=$1 AND enabled FOR UPDATE",
            [merchantId],
          )
        ).rowCount;
        if (!enabled)
          throw new AppError(
            "merchant_disabled",
            "This merchant is not ready for activation.",
            403,
          );
        const invite = (
          await db.query(
            "SELECT * FROM invitations WHERE code_hash=$1 AND account_id=$2 FOR UPDATE",
            [hash(body.code), a.id],
          )
        ).rows[0];
        if (!invite)
          throw new AppError(
            "invitation_unavailable",
            "Enter the invite code generated for this merchant account.",
            400,
          );
        if (invite.consumed_at) {
          // A lost HTTP response must not strand this phone after consuming its code.
          const prior = (
            await db.query(
              "SELECT id FROM terminals WHERE id=$1 AND merchant_id=$2 AND public_key=$3 AND revoked_at IS NULL",
              [invite.activated_terminal_id, merchantId, body.publicKey],
            )
          ).rows[0];
          if (prior) return { id: prior.id, merchantId };
          throw new AppError(
            "invitation_unavailable",
            "This code was already used. Get a new invite code.",
            400,
          );
        }
        if (invite.expires_at.getTime() <= Date.now())
          throw new AppError(
            "invitation_unavailable",
            "This code expired. Tap Get invite code for a new one.",
            400,
          );
        const existing = (
          await db.query(
            "SELECT id FROM terminals WHERE merchant_id=$1 AND public_key=$2 AND revoked_at IS NULL LIMIT 1",
            [merchantId, body.publicKey],
          )
        ).rows[0];
        const id = existing?.id ?? randomUUID();
        if (!existing)
          await db.query(
            "INSERT INTO terminals(id,merchant_id,public_key,name) VALUES($1,$2,$3,'Suica Pay iPhone')",
            [id, merchantId, body.publicKey],
          );
        await db.query(
          "UPDATE invitations SET consumed_at=now(),activated_terminal_id=$2 WHERE id=$1",
          [invite.id, id],
        );
        await db.query(
          "INSERT INTO audit_events(account_id,event,reference) VALUES($1,'merchant_phone_activated',$2)",
          [a.id, id],
        );
        return { id, merchantId };
      });
    },
  );
  app.post(
    "/v1/merchants/register",
    {
      config: { rateLimit: { max: 20, timeWindow: "5 minutes" } },
    },
    async (req) => {
      const { name, signupSecret } = z
        .object({
          name: z.string().trim().min(1).max(80),
          signupSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        })
        .strict()
        .parse(req.body);
      if (!hasPayments || !config.AWS_KMS_OPERATOR_KEY_ID)
        throw new AppError(
          "merchant_setup_unavailable",
          "Merchant signup is temporarily unavailable. Please try again later.",
          503,
        );
      const signupHash = hash(signupSecret);
      const actor = createHmac("sha256", config.CARD_HMAC_SECRET)
        .update(req.ip)
        .digest("hex");
      return transaction(async (db) => {
        // Claim the request before any cloud key or blockchain transaction is created.
        await db.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,71))",
          [signupHash],
        );
        const existing = (
          await db.query(
            "SELECT account_id,name FROM merchant_registrations WHERE signup_hash=$1",
            [signupHash],
          )
        ).rows[0];
        if (existing) {
          if (existing.name !== name)
            throw new AppError(
              "signup_conflict",
              "Continue the merchant signup you already started.",
              409,
            );
          const active = (
            await db.query(
              "SELECT 1 FROM sessions WHERE token_hash=$1 AND account_id=$2 AND revoked_at IS NULL AND expires_at>now()",
              [signupHash, existing.account_id],
            )
          ).rowCount;
          if (!active)
            throw new AppError(
              "signup_expired",
              "This setup session expired. Sign in using a merchant invitation from an existing device.",
              410,
            );
          return { token: signupSecret, accountId: existing.account_id };
        }
        await db.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,72))",
          [actor],
        );
        const count = (
          await db.query(
            "SELECT count(*)::int n FROM merchant_registrations WHERE actor_hash=$1 AND created_at>now()-interval '1 hour'",
            [actor],
          )
        ).rows[0].n;
        if (count >= 5)
          throw new AppError(
            "rate_limited",
            "Too many new merchant accounts from this connection. Try again later.",
            429,
          );
        const accountId = randomUUID();
        await db.query("INSERT INTO accounts(id,role) VALUES($1,'merchant')", [
          accountId,
        ]);
        await db.query(
          "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+$3*interval '1 hour')",
          [signupHash, accountId, config.SESSION_HOURS],
        );
        await db.query(
          "INSERT INTO wallets(account_id,key_name,status) VALUES($1,$2,'provisioning')",
          [accountId, `suica-${accountId}`],
        );
        await db.query(
          "INSERT INTO merchant_registrations(account_id,reserved_merchant_id,name,signup_hash,actor_hash,reserved_operation_id) VALUES($1,$2,$3,$4,$5,$6)",
          [accountId, randomUUID(), name, signupHash, actor, randomUUID()],
        );
        await db.query(
          "INSERT INTO audit_events(account_id,event) VALUES($1,'merchant_signup_started')",
          [accountId],
        );
        return { token: signupSecret, accountId };
      });
    },
  );

  app.get("/v1/merchant/setup", async (req) => {
    const a = await authenticate(req);
    if (a.role !== "merchant")
      throw new AppError(
        "merchant_required",
        "A merchant account is required.",
        403,
      );
    const row = (
      await pool.query(
        "SELECT name,stage,error_code FROM merchant_registrations WHERE account_id=$1",
        [a.id],
      )
    ).rows[0];
    const registered = (
      await pool.query("SELECT name,enabled FROM merchants WHERE id=$1", [
        a.merchant_id,
      ])
    ).rows[0];
    if (row?.stage === "ready" || !row) {
      if (!registered?.enabled)
        throw new AppError(
          "merchant_unavailable",
          "This merchant account is not available.",
          409,
        );
      return {
        name: registered.name,
        status: "ready",
        message: "Your merchant account is ready.",
      };
    }
    return {
      name: row.name,
      status:
        row.error_code && row.error_code !== "wallet_operation_pending"
          ? "needs_attention"
          : row.stage,
      message:
        row.error_code && row.error_code !== "wallet_operation_pending"
          ? "Setup is taking longer than expected. Your account is saved; check again shortly."
          : row.stage === "wallet"
            ? "Creating your merchant wallet…"
            : "Registering your merchant for payments. Waiting for network confirmation…",
    };
  });

  app.post(
    "/v1/merchant/invitations",
    {
      config: { rateLimit: { max: 5, timeWindow: "5 minutes" } },
    },
    async (req) => {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      const a = await authenticate(req);
      const merchantId = merchant(a);
      const details = (
        await pool.query("SELECT name FROM merchants WHERE id=$1 AND enabled", [
          merchantId,
        ])
      ).rows[0];
      if (!details)
        throw new AppError(
          "merchant_unavailable",
          "Finish merchant setup before getting an activation code.",
          409,
        );
      return { ...(await createInvitation(a.id)), merchantName: details.name };
    },
  );
}
