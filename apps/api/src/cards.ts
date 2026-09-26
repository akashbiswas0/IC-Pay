import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { authenticate, customer } from "./auth.js";
import { pool, transaction } from "./db.js";
import { AppError } from "./errors.js";

export type CardLinkPurpose = "enrollment" | "addition" | "replacement";
export function publicCard(row: any) {
  return {
    id: row.id,
    nickname: row.nickname,
    last4: row.last4,
    status: row.active ? "active" : "frozen",
    linkedAt: row.linked_at.toISOString(),
  };
}

/** All card mutations take the account lock before card locks, like payment authorization. */
async function lockAccount(db: PoolClient, accountId: string) {
  await db.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [accountId]);
}

export async function prepareCardLink(
  db: PoolClient,
  accountId: string,
  purpose: CardLinkPurpose,
  cardHash: string,
  replacesCardId?: string,
) {
  await lockAccount(db, accountId);
  const existing = (
    await db.query(
      "SELECT account_id,removed_at FROM cards WHERE card_hash=$1",
      [cardHash],
    )
  ).rows[0];
  if (existing && existing.account_id !== accountId)
    throw new AppError(
      "card_linked",
      "This Suica belongs to another account.",
      409,
    );
  if (existing && existing.removed_at === null)
    throw new AppError(
      "card_already_linked",
      "This Suica is already in your cards.",
      409,
    );
  if (purpose !== "replacement") {
    if (replacesCardId)
      throw new AppError(
        "invalid_operation",
        "Choose Add card or Replace card.",
        400,
      );
    return { id: null, generation: null };
  }
  const targets = (
    await db.query(
      "SELECT id,linked_at::text generation FROM cards WHERE account_id=$1 AND removed_at IS NULL AND ($2::uuid IS NULL OR id=$2) ORDER BY id FOR UPDATE",
      [accountId, replacesCardId ?? null],
    )
  ).rows;
  // Old clients may replace their only card, never all cards on a multi-card account.
  if (targets.length !== 1)
    throw new AppError(
      "choose_card",
      "Choose the Suica you want to replace.",
      409,
    );
  return targets[0] as { id: string; generation: string };
}

/** Called only after server-side World proof verification, inside that same transaction. */
export async function applyVerifiedCardLink(
  db: PoolClient,
  request: {
    account_id: string;
    purpose: CardLinkPurpose;
    card_hash: string;
    card_last4: string;
    replaces_card_id: string | null;
    replaces_card_generation: string | null;
  },
) {
  const target = await prepareCardLink(
    db,
    request.account_id,
    request.purpose,
    request.card_hash,
    request.replaces_card_id ?? undefined,
  );
  if (request.purpose === "replacement") {
    if (
      request.replaces_card_generation &&
      target.generation !== request.replaces_card_generation
    )
      throw new AppError(
        "card_changed",
        "This card changed. Start a new replacement.",
        409,
      );
    await db.query(
      "UPDATE cards SET active=false,removed_at=clock_timestamp(),linked_at=GREATEST(clock_timestamp(),cards.linked_at + interval '1 microsecond') WHERE id=$1",
      [target.id],
    );
  }
  const linked = await db.query(
    `INSERT INTO cards(card_hash,account_id,last4) VALUES($1,$2,$3)
     ON CONFLICT(card_hash) DO UPDATE SET active=true,removed_at=NULL,linked_at=GREATEST(clock_timestamp(),cards.linked_at + interval '1 microsecond')
     WHERE cards.account_id=excluded.account_id AND cards.removed_at IS NOT NULL RETURNING id`,
    [request.card_hash, request.account_id, request.card_last4],
  );
  if (!linked.rowCount)
    throw new AppError("card_linked", "This Suica is already linked.", 409);
  if (request.purpose === "replacement") {
    const newCardId = linked.rows[0].id;
    const hasWallet = (
      await db.query("SELECT 1 FROM wallets WHERE card_id=$1", [newCardId])
    ).rowCount;
    if (hasWallet)
      throw new AppError(
        "card_has_wallet",
        "That card already has a wallet. Add it separately.",
        409,
      );
    await db.query(
      "UPDATE wallets SET card_id=$2 WHERE account_id=$3 AND card_id=$1",
      [target.id, newCardId, request.account_id],
    );
    // Preserve the existing replacement safeguard without resetting any shared budget.
    await db.query(
      "UPDATE policies SET card_id=$2,enabled=false WHERE card_id=$1 AND account_id=$3",
      [target.id, newCardId, request.account_id],
    );
  }
  return linked.rows[0].id as string;
}

export async function cardRoutes(app: FastifyInstance) {
  const params = z.object({ id: z.uuid() });
  app.get("/v1/cards", async (req) => {
    const account = await authenticate(req);
    customer(account);
    const { rows } = await pool.query(
      "SELECT * FROM cards WHERE account_id=$1 AND removed_at IS NULL ORDER BY linked_at,id",
      [account.id],
    );
    return { cards: rows.map(publicCard) };
  });
  app.patch("/v1/cards/:id", async (req) => {
    const account = await authenticate(req);
    customer(account);
    const { id } = params.parse(req.params);
    const body = z
      .object({
        nickname: z.string().trim().min(1).max(32).optional(),
        frozen: z.boolean().optional(),
      })
      .strict()
      .refine(
        (value) => value.nickname !== undefined || value.frozen !== undefined,
      )
      .parse(req.body);
    return transaction(async (db) => {
      await lockAccount(db, account.id);
      const { rows } = await db.query(
        `UPDATE cards SET nickname=COALESCE($3,nickname),
         linked_at=CASE WHEN $4::boolean IS NOT NULL AND active=$4 THEN GREATEST(clock_timestamp(),cards.linked_at + interval '1 microsecond') ELSE linked_at END,
         active=COALESCE(NOT $4::boolean,active)
         WHERE id=$1 AND account_id=$2 AND removed_at IS NULL RETURNING *`,
        [id, account.id, body.nickname ?? null, body.frozen ?? null],
      );
      if (!rows[0]) throw new AppError("not_found", "Card not found.", 404);
      await db.query(
        "INSERT INTO audit_events(account_id,event,reference) VALUES($1,$2,$3)",
        [
          account.id,
          body.frozen === undefined
            ? "card_renamed"
            : body.frozen
              ? "card_frozen"
              : "card_unfrozen",
          id,
        ],
      );
      return publicCard(rows[0]);
    });
  });
  app.delete("/v1/cards/:id", async (req) => {
    const account = await authenticate(req);
    customer(account);
    const { id } = params.parse(req.params);
    return transaction(async (db) => {
      await lockAccount(db, account.id);
      const { rows } = await db.query(
        "SELECT removed_at FROM cards WHERE id=$1 AND account_id=$2 FOR UPDATE",
        [id, account.id],
      );
      if (!rows[0]) throw new AppError("not_found", "Card not found.", 404);
      if (rows[0].removed_at === null) {
        await db.query(
          "UPDATE cards SET active=false,removed_at=clock_timestamp(),linked_at=GREATEST(clock_timestamp(),cards.linked_at + interval '1 microsecond') WHERE id=$1",
          [id],
        );
        await db.query(
          "INSERT INTO audit_events(account_id,event,reference) VALUES($1,'card_removed',$2)",
          [account.id, id],
        );
      }
      return { removed: true };
    });
  });
}
