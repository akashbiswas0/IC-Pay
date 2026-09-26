import { createPublicKey } from "node:crypto";
import {
  KMSClient,
  CreateKeyCommand,
  CreateAliasCommand,
  GetPublicKeyCommand,
  ListAliasesCommand,
  ListKeysCommand,
  ListResourceTagsCommand,
  SignCommand,
  type ListAliasesCommandOutput,
  type ListKeysCommandOutput,
  type ListResourceTagsCommandOutput,
} from "@aws-sdk/client-kms";
import {
  computeAddress,
  getAddress,
  getBytes,
  hexlify,
  recoverAddress,
  Signature,
  toBeHex,
  Transaction,
  type TransactionLike,
} from "ethers";

const CURVE_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const PROJECT = "suica-pay";
export type KmsWallet = { keyId: string; address: string };
export type SignedKmsTransaction = {
  signedTx: string;
  hash: string;
  nonce: string;
};

export class KmsWalletNotFoundError extends Error {
  constructor() {
    super(
      "No AWS KMS key was found for this wallet reference. No key was created.",
    );
    this.name = "KmsWalletNotFoundError";
  }
}

/** Accept only a canonical DER SPKI containing an actual secp256k1 EC public key. */
export function addressFromSpki(spki: Uint8Array): string {
  const encoded = Buffer.from(spki);
  const key = createPublicKey({ key: encoded, format: "der", type: "spki" });
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "secp256k1"
  ) {
    throw new Error("AWS KMS public key must use secp256k1.");
  }
  if (!encoded.equals(key.export({ format: "der", type: "spki" }))) {
    throw new Error(
      "AWS KMS public key must use canonical SPKI encoding without trailing bytes.",
    );
  }
  const jwk = key.export({ format: "jwk" });
  if (jwk.crv !== "secp256k1" || !jwk.x || !jwk.y)
    throw new Error("Invalid secp256k1 public key coordinates.");
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  if (x.length !== 32 || y.length !== 32)
    throw new Error("Invalid secp256k1 public key length.");
  return computeAddress(
    hexlify(Buffer.concat([Buffer.from([4]), x, y])),
  ).toLowerCase();
}

/** Strict DER parsing, EIP-2 normalization, then Ethereum recovery against the trusted public key. */
export function signatureFromDer(
  digest: string,
  der: Uint8Array,
  expectedAddress: string,
): Signature {
  if (getBytes(digest).length !== 32)
    throw new Error("Ethereum signing digest must be 32 bytes.");
  const bytes = Buffer.from(der);
  if (
    bytes.length < 8 ||
    bytes.length > 72 ||
    bytes[0] !== 0x30 ||
    bytes[1] !== bytes.length - 2
  ) {
    throw new Error("Invalid DER signature sequence.");
  }
  let offset = 2;
  const integer = (): bigint => {
    if (bytes[offset++] !== 0x02)
      throw new Error("Expected DER signature integer.");
    const length = bytes[offset++];
    if (
      length === undefined ||
      length < 1 ||
      length > 33 ||
      offset + length > bytes.length
    ) {
      throw new Error("Invalid DER signature integer length.");
    }
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    if (value[0]! & 0x80) throw new Error("Negative DER signature integer.");
    if (value.length > 1 && value[0] === 0 && !(value[1]! & 0x80))
      throw new Error("Nonminimal DER signature integer.");
    const scalar = BigInt(`0x${value.toString("hex")}`);
    if (scalar === 0n || scalar >= CURVE_ORDER)
      throw new Error("DER signature scalar is outside secp256k1 range.");
    return scalar;
  };
  const r = integer();
  const originalS = integer();
  if (offset !== bytes.length)
    throw new Error("Unexpected trailing DER signature data.");
  const s = originalS > CURVE_ORDER / 2n ? CURVE_ORDER - originalS : originalS;
  const expected = getAddress(expectedAddress);
  for (const yParity of [0, 1] as const) {
    const signature = Signature.from({
      r: toBeHex(r, 32),
      s: toBeHex(s, 32),
      yParity,
    });
    try {
      if (recoverAddress(digest, signature) === expected) return signature;
    } catch {
      /* Try the other recovery parity. */
    }
  }
  throw new Error(
    "AWS KMS signature does not recover the expected wallet address.",
  );
}

function aliasFor(walletRef: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(walletRef))
    throw new Error(
      "Invalid wallet reference. Use an account UUID or operator identifier.",
    );
  return `alias/${PROJECT}/${walletRef}`;
}

/** Credentials resolve through the AWS SDK default credential chain; no credentials are stored here. */
export class AwsKmsWallets {
  private readonly client: KMSClient;
  private readonly creationClient: KMSClient;
  constructor(region: string) {
    if (!region.trim()) throw new Error("AWS region is required.");
    this.client = new KMSClient({ region });
    // CreateKey has no idempotency token. A timeout must be recovered by tags, never automatically retried.
    this.creationClient = new KMSClient({ region, maxAttempts: 1 });
  }

  private async publicMaterial(keyId: string): Promise<KmsWallet> {
    const result = await this.client.send(
      new GetPublicKeyCommand({ KeyId: keyId }),
    );
    if (
      !result.KeyId ||
      !result.PublicKey ||
      result.KeySpec !== "ECC_SECG_P256K1" ||
      result.KeyUsage !== "SIGN_VERIFY" ||
      !result.SigningAlgorithms?.includes("ECDSA_SHA_256")
    ) {
      throw new Error(
        "AWS KMS key must be ECC_SECG_P256K1 with SIGN_VERIFY usage and ECDSA_SHA_256 support.",
      );
    }
    return { keyId: result.KeyId, address: addressFromSpki(result.PublicKey) };
  }

  async address(keyId: string): Promise<string> {
    return (await this.publicMaterial(keyId)).address;
  }

  private async findWallet(walletRef: string): Promise<KmsWallet | null> {
    const aliasName = aliasFor(walletRef);
    let aliasTarget: string | undefined;
    let marker: string | undefined;
    do {
      const page: ListAliasesCommandOutput = await this.client.send(
        new ListAliasesCommand({ Marker: marker, Limit: 100 }),
      );
      for (const alias of page.Aliases ?? [])
        if (alias.AliasName === aliasName) aliasTarget = alias.TargetKeyId;
      if (page.Truncated && !page.NextMarker)
        throw new Error("Incomplete AWS KMS alias pagination.");
      marker = page.Truncated ? page.NextMarker : undefined;
    } while (marker);
    const matches = new Set<string>();
    marker = undefined;
    do {
      const page: ListKeysCommandOutput = await this.client.send(
        new ListKeysCommand({ Marker: marker, Limit: 1000 }),
      );
      for (const key of page.Keys ?? []) {
        if (!key.KeyId)
          throw new Error("AWS KMS returned a key without its identifier.");
        const tags = new Map<string, string>();
        let tagMarker: string | undefined;
        try {
          do {
            const tagged: ListResourceTagsCommandOutput =
              await this.client.send(
                new ListResourceTagsCommand({
                  KeyId: key.KeyId,
                  Marker: tagMarker,
                  Limit: 50,
                }),
              );
            for (const tag of tagged.Tags ?? [])
              if (tag.TagKey && tag.TagValue !== undefined)
                tags.set(tag.TagKey, tag.TagValue);
            if (tagged.Truncated && !tagged.NextMarker)
              throw new Error("Incomplete AWS KMS tag pagination.");
            tagMarker = tagged.Truncated ? tagged.NextMarker : undefined;
          } while (tagMarker);
        } catch (error) {
          // Project-scoped IAM cannot inspect unrelated keys discovered by ListKeys.
          // The known wallet alias must remain verifiable; never skip its target.
          if (
            error instanceof Error &&
            error.name === "AccessDeniedException" &&
            key.KeyId !== aliasTarget
          )
            continue;
          throw error;
        }
        if (
          tags.get("Project") === PROJECT &&
          tags.get("WalletRef") === walletRef
        )
          matches.add(key.KeyId);
      }
      if (page.Truncated && !page.NextMarker)
        throw new Error("Incomplete AWS KMS key pagination.");
      marker = page.Truncated ? page.NextMarker : undefined;
    } while (marker);
    if (matches.size > 1)
      throw new Error(
        "Multiple AWS KMS keys match this wallet reference; operator reconciliation is required.",
      );
    const keyId = matches.values().next().value as string | undefined;
    if (aliasTarget && aliasTarget !== keyId)
      throw new Error(
        "AWS KMS wallet alias does not match its project and wallet tags.",
      );
    return keyId ? this.publicMaterial(keyId) : null;
  }

  async recoverWallet(walletRef: string): Promise<KmsWallet> {
    const wallet = await this.findWallet(walletRef);
    if (!wallet) throw new KmsWalletNotFoundError();
    return wallet;
  }

  async createWallet(walletRef: string): Promise<KmsWallet> {
    const aliasName = aliasFor(walletRef);
    const existing = await this.findWallet(walletRef);
    if (existing) return existing;
    // Caller must durably claim provisioning before this call and use recoverWallet after any ambiguous failure.
    const created = await this.creationClient.send(
      new CreateKeyCommand({
        Description: "Suica Pay test-token transaction signer",
        KeySpec: "ECC_SECG_P256K1",
        KeyUsage: "SIGN_VERIFY",
        Tags: [
          { TagKey: "Project", TagValue: PROJECT },
          { TagKey: "WalletRef", TagValue: walletRef },
        ],
      }),
    );
    const keyId = created.KeyMetadata?.Arn;
    if (!keyId)
      throw new Error(
        "AWS KMS creation returned no key ARN; recover by wallet tags before retrying.",
      );
    await this.creationClient.send(
      new CreateAliasCommand({ AliasName: aliasName, TargetKeyId: keyId }),
    );
    return this.publicMaterial(keyId);
  }

  async signTransaction(
    keyId: string,
    input: TransactionLike,
    expectedAddress?: string,
  ): Promise<SignedKmsTransaction> {
    if (input.signature)
      throw new Error("Only unsigned transactions can be signed.");
    if (input.chainId == null || BigInt(input.chainId) <= 0n)
      throw new Error("An explicit positive chain ID is required.");
    if (
      input.nonce == null ||
      !Number.isSafeInteger(input.nonce) ||
      input.nonce < 0
    )
      throw new Error(
        "An explicit nonnegative safe-integer nonce is required.",
      );
    if (input.gasLimit == null || BigInt(input.gasLimit) <= 0n)
      throw new Error("An explicit positive gas limit is required.");
    if (
      input.gasPrice == null &&
      (input.maxFeePerGas == null || input.maxPriorityFeePerGas == null)
    )
      throw new Error("Explicit transaction fee parameters are required.");
    const { from, ...unsignedInput } = input;
    const transaction = Transaction.from(unsignedInput);
    if (![0, 1, 2].includes(transaction.inferType()))
      throw new Error(
        "Only legacy, access-list, and EIP-1559 transactions are supported.",
      );
    const wallet = await this.publicMaterial(keyId);
    if (
      expectedAddress &&
      getAddress(expectedAddress) !== getAddress(wallet.address)
    )
      throw new Error(
        "AWS KMS key does not match the expected wallet address.",
      );
    if (from && getAddress(from) !== getAddress(wallet.address))
      throw new Error("Transaction sender does not match the AWS KMS wallet.");
    // DIGEST signs this exact Keccak-256 hash. RAW would incorrectly hash it again using SHA-256.
    const result = await this.client.send(
      new SignCommand({
        KeyId: wallet.keyId,
        Message: getBytes(transaction.unsignedHash),
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      }),
    );
    if (
      result.KeyId !== wallet.keyId ||
      result.SigningAlgorithm !== "ECDSA_SHA_256" ||
      !result.Signature
    )
      throw new Error(
        "AWS KMS returned an unexpected signing key or algorithm.",
      );
    transaction.signature = signatureFromDer(
      transaction.unsignedHash,
      result.Signature,
      wallet.address,
    );
    const signedTx = transaction.serialized;
    const recovered = Transaction.from(signedTx);
    if (recovered.from?.toLowerCase() !== wallet.address || !recovered.hash)
      throw new Error(
        "Signed transaction does not recover the AWS KMS wallet.",
      );
    return {
      signedTx,
      hash: recovered.hash,
      nonce: recovered.nonce.toString(),
    };
  }
}
