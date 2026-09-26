import { testFundingRoutes } from "./test-funding.js";
import { loyaltyRoutes } from "./loyalty.js";
import { loyaltyRefundRoutes } from "./loyalty-refunds.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { routes } from "./routes.js";
import { webhookRoutes } from "./webhooks.js";
import { worldRoutes } from "./world.js";
import { rewardRoutes } from "./rewards.js";
import { deviceAuthRoutes } from "./device-auth.js";
import { merchantSignupRoutes } from "./merchant-signup.js";
import { cardRoutes } from "./cards.js";
export async function buildServer() {
  const app = Fastify({
    logger: {
      level: "info",
      redact: ["req.headers.authorization", "req.body", "res.headers"],
    },
    disableRequestLogging: true,
    bodyLimit: 65536,
    trustProxy:
      config.TRUST_PROXY_HOPS === 0
        ? false
        : (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const pathname = req.url.split("?")[0];
    if (
      pathname === "/health" ||
      pathname?.startsWith("/health/") ||
      pathname === "/v1" ||
      pathname?.startsWith("/v1/")
    ) {
      reply.header("Cache-Control", "private, no-store");
      const current = reply.getHeader("Vary");
      const values = (
        Array.isArray(current) ? current.join(",") : String(current ?? "")
      )
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (!values.includes("*")) {
        for (const name of ["Origin", "Cookie", "Authorization"])
          if (
            !values.some((value) => value.toLowerCase() === name.toLowerCase())
          )
            values.push(name);
        reply.header("Vary", values.join(", "));
      }
    }
    return payload;
  });
  await app.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: "Some request fields are invalid.",
        },
      });
    if (err instanceof AppError)
      return reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message } });
    if ((err as { code?: string }).code === "23505")
      return reply.code(409).send({
        error: {
          code: "conflict",
          message: "This operation already exists or was already used.",
        },
      });
    if (
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      typeof err.statusCode === "number" &&
      err.statusCode < 500
    )
      return reply.code(err.statusCode).send({
        error: {
          code: err.statusCode === 429 ? "rate_limited" : "invalid_request",
          message:
            err.statusCode === 429
              ? "Too many requests. Try again shortly."
              : "The request could not be accepted.",
        },
      });
    // Do not serialize provider errors, proof payloads or card identifiers into logs.
    req.log.error(
      { errorType: err instanceof Error ? err.name : "unknown" },
      "Request failed",
    );
    return reply.code(500).send({
      error: {
        code: "internal_error",
        message:
          "The operation could not be completed. Try again after checking its status.",
      },
    });
  });
  await app.register(routes);
  await app.register(testFundingRoutes);
  await app.register(rewardRoutes);
  await app.register(loyaltyRoutes);
  await app.register(loyaltyRefundRoutes);
  await app.register(worldRoutes);
  await app.register(cardRoutes);
  await app.register(deviceAuthRoutes);
  await app.register(merchantSignupRoutes);
  await app.register(webhookRoutes);
  return app;
}
