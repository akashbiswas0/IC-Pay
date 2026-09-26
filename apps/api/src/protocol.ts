import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import { keccak256, getBytes, Wallet, zeroPadValue, toBeHex } from "ethers";
import { z } from "zod";
import { wholePointsSchema } from "./loyalty-protocol.js";
export const amountSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/)
  .refine((v) => {
    try {
      return BigInt(v) < 1n << 256n;
    } catch {
      return false;
    }
  }, "Amount exceeds uint256");
export const cardSchema = z.string().regex(/^[0-9A-F]{16}$/);
const legacyScanSchema = z
  .object({
    version: z.literal(1),
    terminalId: z.uuid(),
    invoiceId: z.string().regex(/^0x[0-9a-f]{64}$/),
    challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    cardId: cardSchema,
    chainId: z.string().regex(/^[1-9][0-9]*$/),
    token: z.string().regex(/^0x[0-9a-f]{40}$/),
    amount: amountSchema,
    expiresAt: z.iso.datetime(),
  })
  .strict();
export const scanSchema = z.discriminatedUnion("version", [
  legacyScanSchema,
  legacyScanSchema
    .extend({
      version: z.literal(2),
      routerAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
      useReward: z.boolean(),
    })
    .strict(),
  legacyScanSchema
    .extend({
      version: z.literal(3),
      routerAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
      useReward: z.boolean(),
      maxPoints: wholePointsSchema.nullable(),
    })
    .strict(),
]);
export type Scan = z.infer<typeof scanSchema>;
export const randomToken = () => randomBytes(32).toString("base64url");
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const cardHash = (s: string, secret: string) =>
  createHmac("sha256", secret).update(cardSchema.parse(s)).digest("hex");
export function canonicalScan(p: Scan): Buffer {
  return Buffer.from(
    [
      p.version === 3
        ? "suica-payments-v3"
        : p.version === 2
          ? "suica-payments-v2"
          : "suica-payments-v1",
      p.terminalId,
      p.invoiceId,
      p.challenge,
      p.cardId,
      p.chainId,
      p.token,
      p.amount,
      p.expiresAt,
      ...(p.version >= 2
        ? [
            (p as Exclude<Scan, { version: 1 }>).routerAddress,
            (p as Exclude<Scan, { version: 1 }>).useReward ? "1" : "0",
          ]
        : []),
      ...(p.version === 3 ? [p.maxPoints ?? "auto"] : []),
    ].join("\n"),
    "utf8",
  );
}
export function publicKey(base64: string) {
  const key = createPublicKey({
    key: Buffer.from(base64, "base64"),
    format: "der",
    type: "spki",
  });
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    throw new Error("P-256 public key required");
  return key;
}
export function verifyScan(p: Scan, signature: string, spki: string): boolean {
  try {
    return verify(
      "sha256",
      canonicalScan(scanSchema.parse(p)),
      publicKey(spki),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}
export function fieldHash(bytes: Uint8Array): string {
  return zeroPadValue(toBeHex(BigInt(keccak256(bytes)) >> 8n), 32);
}
export async function signWorldRequest(
  key: string,
  nonceBytes = randomBytes(32),
  now = Math.floor(Date.now() / 1000),
) {
  const nonce = fieldHash(nonceBytes);
  const expires = now + 300;
  const data = Buffer.alloc(49);
  data[0] = 1;
  Buffer.from(getBytes(nonce)).copy(data, 1);
  data.writeBigUInt64BE(BigInt(now), 33);
  data.writeBigUInt64BE(BigInt(expires), 41);
  const signature = await new Wallet(
    key.startsWith("0x") ? key : `0x${key}`,
  ).signMessage(data);
  return { nonce, created_at: now, expires_at: expires, signature };
}
export function withinBudget(
  amount: string,
  perPayment: string,
  total: string,
  spent: string,
  reserved: string,
  allowZero = false,
): boolean {
  const n = BigInt(amount);
  return (
    (n > 0n || (allowZero && n === 0n)) &&
    n <= BigInt(perPayment) &&
    n + BigInt(spent) + BigInt(reserved) <= BigInt(total)
  );
}
