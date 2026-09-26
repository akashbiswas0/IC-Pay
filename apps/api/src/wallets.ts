import { KMSClient } from "@aws-sdk/client-kms";
import { AwsKmsWallets } from "./aws-kms.js";
import { config } from "./config.js";
import { AppError } from "./errors.js";
let wallets: Promise<AwsKmsWallets> | undefined;
export function kmsWallets(): Promise<AwsKmsWallets> {
  return (wallets ??= (async () => {
    try {
      const client = new KMSClient({});
      const region = config.AWS_REGION ?? (await client.config.region());
      client.destroy();
      return new AwsKmsWallets(region);
    } catch {
      wallets = undefined;
      throw new AppError(
        "aws_unconfigured",
        "Configure an AWS region and credentials with access to KMS.",
        503,
      );
    }
  })());
}
export function requireAwsWallet(wallet: {
  provider: string;
  key_id: string | null;
}) {
  if (wallet.provider !== "aws_kms")
    throw new AppError(
      "wallet_migration_required",
      "This wallet uses the previous custody provider. Explicit migration is required; it will not be silently replaced.",
      409,
    );
  if (!wallet.key_id)
    throw new AppError(
      "wallet_key_unavailable",
      "Recover the existing AWS KMS wallet before signing.",
      409,
    );
  return wallet.key_id;
}
