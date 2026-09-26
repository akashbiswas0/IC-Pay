import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { transaction } from "./db.js";
export function validWebhook(
  raw: Buffer,
  timestamp: string,
  signature: string,
  secret: string,
  now = Date.now(),
): boolean {
  if (
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !/^([a-fA-F0-9]{64})$/.test(signature)
  )
    return false;
  const expected = createHmac("sha256", secret)
    .update(raw)
    .update(timestamp)
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
export async function webhookRoutes(app: FastifyInstance) {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  app.post("/v1/webhooks/multibaas", async (req) => {
    if (!config.MULTIBAAS_WEBHOOK_SECRET)
      throw new AppError(
        "webhook_unconfigured",
        "Webhook signing secret is not configured.",
        503,
      );
    const raw = req.body as Buffer;
    const timestamp = req.headers["x-multibaas-timestamp"];
    const signature = req.headers["x-multibaas-signature"];
    if (
      typeof timestamp !== "string" ||
      typeof signature !== "string" ||
      !validWebhook(raw, timestamp, signature, config.MULTIBAAS_WEBHOOK_SECRET)
    )
      throw new AppError(
        "invalid_webhook",
        "Webhook signature is invalid.",
        401,
      );
    let json: unknown;
    try {
      json = JSON.parse(raw.toString());
    } catch {
      throw new AppError("invalid_request", "Invalid webhook JSON.");
    }
    const events = z
      .array(
        z.object({
          id: z.string().min(1).max(200),
          event: z.enum(["transaction.included", "event.emitted"]),
          data: z.record(z.string(), z.unknown()),
        }),
      )
      .max(100)
      .parse(json);
    await transaction(async (db) => {
      for (const event of events) {
        const inserted = await db.query(
          "INSERT INTO webhook_deliveries(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id",
          [event.id],
        );
        if (!inserted.rowCount) continue;
        // A webhook is only a wakeup hint: independently fetch chain receipts before changing payment status.
        await db.query(
          `UPDATE payment_jobs SET updated_at=to_timestamp(0) WHERE status IN ('pending','submitting','reconciling')`,
        );
      }
    });
    return { accepted: true };
  });
}
