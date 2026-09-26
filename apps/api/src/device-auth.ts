import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, issueSession, browserSessionCookie } from "./auth.js";
import { config, hasWorld } from "./config.js";
import { pool, transaction } from "./db.js";
import { AppError } from "./errors.js";
import { cardHash, cardSchema, hash, randomToken } from "./protocol.js";
import { beginWorldRequest } from "./world.js";
const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function humanCode(length = 8) {
  return [...randomBytes(length)].map((v) => alphabet[v & 31]).join("");
}
function displayCode(code: string) {
  return code.match(/.{1,4}/g)!.join("-");
}
const codeSchema = (length: number) =>
  z
    .string()
    .max(40)
    .transform((v) => v.toUpperCase().replace(/[\s-]/g, ""))
    .pipe(
      z
        .string()
        .length(length)
        .regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$/),
    );
const secretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const ipActor = (req: FastifyRequest) =>
  createHmac("sha256", config.CARD_HMAC_SECRET).update(req.ip).digest("hex");
async function limitAttempts(actor: string, kind: string, max: number) {
  await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,32))", [
      `${kind}:${actor}`,
    ]);
    const count = (
      await db.query(
        "SELECT count(*)::int n FROM auth_attempts WHERE actor_hash=$1 AND kind=$2 AND created_at>now()-interval '5 minutes'",
        [actor, kind],
      )
    ).rows[0].n;
    if (count >= max)
      throw new AppError(
        "rate_limited",
        "Too many attempts. Try again in a few minutes.",
        429,
      );
    // This transaction commits separately so failed exchanges still count.
    await db.query("INSERT INTO auth_attempts(actor_hash,kind) VALUES($1,$2)", [
      actor,
      kind,
    ]);
  });
}
export async function createInvitation(accountId: string) {
  const code = humanCode(16);
  const id = randomUUID();
  const row = (
    await pool.query(
      "INSERT INTO invitations(id,account_id,code_hash,expires_at) SELECT $1,a.id,$3,now()+interval '10 minutes' FROM accounts a JOIN merchant_operators o ON o.account_id=a.id JOIN merchants m ON m.id=o.merchant_id WHERE a.id=$2 AND a.role='merchant' AND m.enabled RETURNING expires_at",
      [id, accountId, hash(code)],
    )
  ).rows[0];
  if (!row)
    throw new AppError(
      "merchant_unavailable",
      "The account must be an enrolled, enabled merchant operator.",
      409,
    );
  return { code: displayCode(code), expiresAt: row.expires_at.toISOString() };
}
export async function deviceAuthRoutes(app: FastifyInstance) {
  app.post(
    "/v1/device-links",
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (req) => {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      await limitAttempts(ipActor(req), "device_create", 10);
      const id = randomUUID(),
        code = humanCode(),
        deviceSecret = randomToken();
      const { rows } = await pool.query(
        "INSERT INTO device_links(id,code_hash,secret_hash,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes') RETURNING expires_at",
        [id, hash(code), hash(deviceSecret)],
      );
      return {
        id,
        userCode: displayCode(code),
        deviceSecret,
        expiresAt: rows[0].expires_at.toISOString(),
      };
    },
  );
  app.post("/v1/device-links/approve", async (req) => {
    const account = await authenticate(req);
    const { userCode } = z
      .object({ userCode: codeSchema(8) })
      .strict()
      .parse(req.body);
    if (account.role === "customer" && !account.verified)
      throw new AppError(
        "verification_required",
        "Finish account verification before connecting another device.",
        403,
      );
    await limitAttempts(hash(account.id), "device_approve", 10);
    return transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM device_links WHERE code_hash=$1 FOR UPDATE",
          [hash(userCode)],
        )
      ).rows[0];
      if (!row || row.expires_at.getTime() <= Date.now() || row.consumed_at)
        throw new AppError(
          "device_link_unavailable",
          "This connection code is invalid or expired.",
          404,
        );
      if (row.approved_at)
        throw new AppError(
          "device_link_approved",
          "This connection was already approved.",
          409,
        );
      if (
        account.role === "merchant" &&
        !(
          await db.query("SELECT 1 FROM merchants WHERE id=$1 AND enabled", [
            account.merchant_id,
          ])
        ).rowCount
      )
        throw new AppError(
          "merchant_disabled",
          "This merchant is disabled.",
          403,
        );
      await db.query(
        "UPDATE device_links SET account_id=$2,approved_at=now() WHERE id=$1",
        [row.id, account.id],
      );
      await db.query(
        "INSERT INTO audit_events(account_id,event,reference) VALUES($1,'device_link_approved',$2)",
        [account.id, row.id],
      );
      return { approved: true };
    });
  });
  app.post("/v1/device-links/:id/poll", async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { deviceSecret, browser } = z
      .object({ deviceSecret: secretSchema, browser: z.boolean().optional() })
      .strict()
      .parse(req.body);
    const result = await transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM device_links WHERE id=$1 AND secret_hash=$2 FOR UPDATE",
          [id, hash(deviceSecret)],
        )
      ).rows[0];
      if (!row)
        throw new AppError(
          "device_link_unavailable",
          "Device connection is unavailable.",
          404,
        );
      if (row.consumed_at)
        throw new AppError(
          "device_link_consumed",
          "This connection was already delivered. Start another connection if needed.",
          410,
        );
      if (row.expires_at.getTime() <= Date.now())
        throw new AppError(
          "device_link_expired",
          "This connection expired. Start a new connection.",
          410,
        );
      if (!row.approved_at) return { status: "pending" };
      const eligible = (
        await db.query(
          "SELECT 1 FROM accounts a LEFT JOIN merchant_operators o ON o.account_id=a.id LEFT JOIN merchants m ON m.id=o.merchant_id WHERE a.id=$1 AND (a.role='admin' OR (a.role='customer' AND a.verified) OR (a.role='merchant' AND m.enabled))",
          [row.account_id],
        )
      ).rowCount;
      if (!eligible)
        throw new AppError(
          "device_link_unavailable",
          "This account can no longer approve this connection.",
          403,
        );
      const token = await issueSession(db, row.account_id, 1);
      await db.query("UPDATE device_links SET consumed_at=now() WHERE id=$1", [
        id,
      ]);
      return { status: "approved", token };
    });
    if (result.status === "approved" && browser) {
      reply.header("Set-Cookie", browserSessionCookie(result.token!));
      return { status: "approved" };
    }
    return result;
  });
  app.post(
    "/v1/invitations/exchange",
    { config: { rateLimit: { max: 20, timeWindow: "5 minutes" } } },
    async (req, reply) => {
      const { code, browser } = z
        .object({ code: codeSchema(16), browser: z.boolean().optional() })
        .strict()
        .parse(req.body);
      await limitAttempts(ipActor(req), "invitation_exchange", 20);
      const result = await transaction(async (db) => {
        const row = (
          await db.query(
            "SELECT i.* FROM invitations i JOIN accounts a ON a.id=i.account_id JOIN merchant_operators o ON o.account_id=a.id JOIN merchants m ON m.id=o.merchant_id WHERE i.code_hash=$1 AND a.role='merchant' AND m.enabled FOR UPDATE OF i",
            [hash(code)],
          )
        ).rows[0];
        if (!row || row.consumed_at || row.expires_at.getTime() <= Date.now())
          throw new AppError(
            "invitation_unavailable",
            "This invitation is invalid, used or expired.",
            400,
          );
        const token = await issueSession(
          db,
          row.account_id,
          browser ? 1 : config.SESSION_HOURS,
        );
        await db.query("UPDATE invitations SET consumed_at=now() WHERE id=$1", [
          row.id,
        ]);
        await db.query(
          "INSERT INTO audit_events(account_id,event,reference) VALUES($1,'invitation_used',$2)",
          [row.account_id, row.id],
        );
        return { token };
      });
      if (browser) {
        reply.header("Set-Cookie", browserSessionCookie(result.token));
        return { signedIn: true };
      }
      return result;
    },
  );
  app.post(
    "/v1/auth/card/start",
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (req) => {
      const { cardId } = z
        .object({ cardId: cardSchema })
        .strict()
        .parse(req.body);
      await limitAttempts(ipActor(req), "card_login", 10);
      if (!hasWorld)
        throw new AppError(
          "world_unconfigured",
          "World verification is not configured.",
          503,
        );
      const account = (
        await pool.query(
          "SELECT a.id,a.world_session,c.active FROM cards c JOIN accounts a ON a.id=c.account_id WHERE c.card_hash=$1 AND a.verified AND a.role='customer' AND a.world_session IS NOT NULL",
          [cardHash(cardId, config.CARD_HMAC_SECRET)],
        )
      ).rows[0];
      if (!account)
        throw new AppError(
          "sign_in_unavailable",
          "This sign-in could not be started. Use your linked card or connect from a signed-in device.",
          400,
        );
      if (!account.active)
        throw new AppError(
          "card_recovery_required",
          "Recover your existing account with this card and World.",
          409,
        );
      const exchangeSecret = randomToken();
      const request = await beginWorldRequest(
        account,
        "login",
        cardId,
        exchangeSecret,
      );
      return {
        id: request.id,
        handoffToken: request.handoffToken,
        exchangeSecret,
        expiresAt: request.expiresAt,
      };
    },
  );
  app.post(
    "/v1/auth/card/recover",
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (req) => {
      const { cardId } = z
        .object({ cardId: cardSchema })
        .strict()
        .parse(req.body);
      await limitAttempts(ipActor(req), "card_login", 10);
      if (!hasWorld)
        throw new AppError(
          "world_unconfigured",
          "World verification is unavailable.",
          503,
        );
      // Card history only locates the account. A fresh proof of its original World session
      // is still required; recovery never reactivates a card or changes spending permission.
      const account = (
        await pool.query(
          "SELECT a.id,a.world_session FROM cards c JOIN accounts a ON a.id=c.account_id WHERE c.card_hash=$1 AND a.verified AND a.role='customer' AND a.world_session IS NOT NULL",
          [cardHash(cardId, config.CARD_HMAC_SECRET)],
        )
      ).rows[0];
      if (!account)
        throw new AppError(
          "recovery_unavailable",
          "Use a Suica previously linked to your account, or another signed-in device.",
          400,
        );
      const exchangeSecret = randomToken();
      const request = await beginWorldRequest(
        account,
        "recovery",
        cardId,
        exchangeSecret,
      );
      return {
        id: request.id,
        handoffToken: request.handoffToken,
        exchangeSecret,
        expiresAt: request.expiresAt,
      };
    },
  );
  app.post("/v1/auth/card/:id/exchange", async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { exchangeSecret } = z
      .object({ exchangeSecret: secretSchema })
      .strict()
      .parse(req.body);
    return transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT r.* FROM world_requests r JOIN accounts a ON a.id=r.account_id WHERE r.id=$1 AND r.exchange_hash=$2 AND r.purpose IN ('login','recovery') AND a.verified AND a.role='customer' FOR UPDATE OF r",
          [id, hash(exchangeSecret)],
        )
      ).rows[0];
      if (!row)
        throw new AppError(
          "sign_in_unavailable",
          "This sign-in is unavailable.",
          404,
        );
      if (row.exchanged_at || row.expires_at.getTime() <= Date.now())
        throw new AppError(
          "sign_in_expired",
          "This sign-in was used or expired. Start again.",
          410,
        );
      if (!row.consumed_at) return { status: "pending" };
      const token = await issueSession(db, row.account_id);
      await db.query(
        "UPDATE world_requests SET exchanged_at=now() WHERE id=$1",
        [id],
      );
      return { status: "verified", token };
    });
  });
}
