import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { randomToken, hash } from "./protocol.js";
import { config } from "./config.js";
import { AppError } from "./errors.js";
export type Account = {
  id: string;
  role: "customer" | "merchant" | "admin";
  verified: boolean;
  world_session: string | null;
  merchant_id: string | null;
};
export function bearer(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ") || header.length > 200)
    throw new AppError(
      "unauthenticated",
      "A valid app session is required.",
      401,
    );
  return header.slice(7);
}
export const browserCookieName = "__Host-suica_session";
export function authenticationToken(req: FastifyRequest): string {
  if (req.headers.authorization !== undefined) return bearer(req);
  const cookie = req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${browserCookieName}=`));
  const token = cookie?.slice(browserCookieName.length + 1);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new AppError("unauthenticated", "Sign in to continue.", 401);
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin !== config.CORS_ORIGIN
  )
    throw new AppError(
      "origin_mismatch",
      "This browser request is not from the application.",
      403,
    );
  return token;
}
export function browserSessionCookie(token: string, maxAge = 3600): string {
  return `${browserCookieName}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}
export async function authenticate(req: FastifyRequest): Promise<Account> {
  const { rows } = await pool.query<Account>(
    `SELECT a.*,o.merchant_id FROM sessions s JOIN accounts a ON a.id=s.account_id LEFT JOIN merchant_operators o ON o.account_id=a.id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL`,
    [hash(authenticationToken(req))],
  );
  if (!rows[0])
    throw new AppError(
      "unauthenticated",
      "This session has expired. Sign in again.",
      401,
    );
  return rows[0];
}
export function customer(a: Account) {
  if (a.role !== "customer" || !a.verified)
    throw new AppError(
      "verification_required",
      "Complete World verification first.",
      403,
    );
}
export function merchant(a: Account) {
  if (!a.merchant_id || a.role !== "merchant")
    throw new AppError(
      "merchant_required",
      "An enrolled merchant operator is required.",
      403,
    );
  return a.merchant_id;
}
export async function issueSession(
  db: PoolClient,
  accountId: string,
  hours = config.SESSION_HOURS,
) {
  const token = randomToken();
  await db.query(
    `INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+$3*interval '1 hour')`,
    [hash(token), accountId, hours],
  );
  return token;
}
export async function createAccount(db: PoolClient, role = "customer") {
  const id = randomUUID();
  await db.query("INSERT INTO accounts(id,role) VALUES($1,$2)", [id, role]);
  return { accountId: id, token: await issueSession(db, id) };
}
