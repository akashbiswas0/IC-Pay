import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
dotenv.config({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
  quiet: true,
});
dotenv.config({ quiet: true });
import { z } from "zod";
import { validMultiBaasURL } from "./funding-history.js";
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase());
const schema = z
  .object({
    DATABASE_URL: z.string().url(),
    TEST_FUNDING_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    TEST_FUNDING_DAILY_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(100),
    DATABASE_SSL_CA_FILE: z.string().min(1).optional(),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(2).default(0),
    CARD_HMAC_SECRET: z.string().min(32),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().default(3001),
    CORS_ORIGIN: z.string().url().default("http://localhost:5173"),
    CHAIN_ID: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .optional(),
    TOKEN_ADDRESS: address.optional(),
    TOKEN_SYMBOL: z.string().default("icUSD"),
    TOKEN_NAME: z.string().default("IC Stablecoin"),
    TOKEN_ONCHAIN_SYMBOL: z.string().default("MJPY"),
    TOKEN_DECIMALS: z.coerce.number().int().min(0).max(36).default(18),
    PAYMENT_ADDRESS: address.optional(),
    REWARD_PAYMENT_ADDRESS: address.optional(),
    LOYALTY_PAYMENT_ADDRESS: address.optional(),
    LOYALTY_PAYMENT_CONTRACT: z.string().default("loyaltypoints"),
    COLLECTIBLE_PAYMENT_ADDRESS: address.optional(),
    COLLECTIBLE_PAYMENT_CONTRACT: z.string().default("collectiblerewards"),
    COLLECTIBLE_ARTWORK_BASE_URL: z
      .string()
      .url()
      .refine((v) => {
        const u = new URL(v);
        return (
          u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          u.pathname.endsWith("/")
        );
      })
      .optional(),
    REWARD_PAYMENT_CONTRACT: z.string().default("rewardpayments"),
    REWARD_READ_MODE: z.enum(["rpc", "multibaas"]).default("rpc"),
    REWARD_READ_RPC_URL: z
      .string()
      .url()
      .refine((v) => {
        const url = new URL(v);
        return url.protocol === "https:" && !url.username && !url.password;
      }, "Reward read RPC must use HTTPS")
      .optional(),
    TOKEN_CONTRACT: z.string().default("matsuristablecoin"),
    PAYMENT_CONTRACT: z.string().default("demopayments"),
    EXPLORER_URL: z.string().url().optional(),
    // Optional display-only balance fallback. Never used for signing or authorization.
    BALANCE_RPC_URL: z
      .string()
      .url()
      .refine(
        (value) => new URL(value).protocol === "https:",
        "Balance RPC must use HTTPS",
      )
      .optional(),
    MULTIBAAS_URL: z
      .string()
      .url()
      .refine(validMultiBaasURL, "MultiBaas must use a clean HTTPS URL")
      .optional(),
    MULTIBAAS_HISTORY_URL: z
      .string()
      .url()
      .refine(validMultiBaasURL, "History MultiBaas must use a clean HTTPS URL")
      .optional(),
    MULTIBAAS_HISTORY_API_KEY: z.string().min(1).optional(),
    MULTIBAAS_API_KEY: z.string().optional(),
    MULTIBAAS_WEBHOOK_SECRET: z.string().min(16).optional(),
    AWS_REGION: z.string().min(1).optional(),
    AWS_KMS_OPERATOR_KEY_ID: z.string().min(1).optional(),
    WORLD_APP_ID: z.string().regex(/^app_/).optional(),
    WORLD_RP_ID: z.string().regex(/^rp_/).optional(),
    WORLD_SIGNING_KEY: z
      .string()
      .regex(/^(0x)?[a-fA-F0-9]{64}$/)
      .optional(),
    WORLD_STAGING_VERIFICATION_TOKEN: z.string().optional(),
    WORLD_ENVIRONMENT: z.enum(["production", "staging"]).default("staging"),
    CONFIRMATIONS: z.coerce.number().int().min(1).default(3),
    SESSION_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  })
  .refine(
    (v) =>
      Boolean(v.MULTIBAAS_HISTORY_URL) === Boolean(v.MULTIBAAS_HISTORY_API_KEY),
    "Set both historical MultiBaas URL and API key, or neither.",
  );
export const config = schema.parse(
  Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== ""),
  ),
);
export const hasWorld = Boolean(
  config.WORLD_APP_ID && config.WORLD_RP_ID && config.WORLD_SIGNING_KEY,
);
export const hasPayments = Boolean(
  ["6497", "11155111"].includes(config.CHAIN_ID ?? "") &&
  config.TOKEN_ADDRESS &&
  config.PAYMENT_ADDRESS &&
  config.MULTIBAAS_URL &&
  config.MULTIBAAS_API_KEY,
);

/** Token display reads do not require the payment router to be deployed yet. */
export const hasTokenReads = Boolean(
  ["6497", "11155111"].includes(config.CHAIN_ID ?? "") &&
  config.TOKEN_ADDRESS &&
  config.MULTIBAAS_URL &&
  config.MULTIBAAS_API_KEY,
);

export const hasRewards = Boolean(
  hasPayments &&
  config.CHAIN_ID === "11155111" &&
  config.REWARD_PAYMENT_ADDRESS,
);

export const hasFundingHistory = Boolean(
  config.MULTIBAAS_HISTORY_URL && config.MULTIBAAS_HISTORY_API_KEY,
);

export const hasTestFunding = Boolean(
  config.TEST_FUNDING_ENABLED &&
  config.CHAIN_ID === "11155111" &&
  hasPayments &&
  config.AWS_KMS_OPERATOR_KEY_ID,
);

export const hasCollectibles = Boolean(
  hasPayments &&
  config.CHAIN_ID === "11155111" &&
  config.COLLECTIBLE_PAYMENT_ADDRESS,
);

export const hasLoyalty = Boolean(
  hasPayments &&
  config.CHAIN_ID === "11155111" &&
  config.LOYALTY_PAYMENT_ADDRESS,
);
