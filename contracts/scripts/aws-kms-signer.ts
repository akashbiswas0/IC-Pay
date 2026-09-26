import {
  AbstractSigner,
  resolveAddress,
  Transaction,
  type Provider,
  type TransactionRequest,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";
import {
  AwsKmsWallets,
  type SignedKmsTransaction,
} from "../../apps/api/src/aws-kms.js";

/** An ethers contract-deployment signer backed by the existing, non-exportable AWS KMS key. */
export class AwsKmsSigner extends AbstractSigner {
  constructor(
    private readonly wallets: AwsKmsWallets,
    private readonly keyId: string,
    private readonly expectedChainId: bigint,
    provider: Provider | null,
    private readonly onSigned?: (signed: SignedKmsTransaction) => Promise<void>,
  ) {
    super(provider);
    if (expectedChainId <= 0n)
      throw new Error("An explicit positive signer chain ID is required.");
  }

  override async getAddress(): Promise<string> {
    return this.wallets.address(this.keyId);
  }

  override connect(provider: Provider | null): AwsKmsSigner {
    return new AwsKmsSigner(
      this.wallets,
      this.keyId,
      this.expectedChainId,
      provider,
      this.onSigned,
    );
  }

  override async signTransaction(input: TransactionRequest): Promise<string> {
    if (!this.provider)
      throw new Error("AWS KMS deployment signer requires a provider.");
    if ((await this.provider.getNetwork()).chainId !== this.expectedChainId)
      throw new Error(
        "RPC chain does not match the configured AWS KMS signer chain.",
      );
    const populated = await this.populateTransaction(input);
    if (BigInt(populated.chainId!) !== this.expectedChainId)
      throw new Error(
        "Transaction chain does not match the configured deployment chain.",
      );
    const { from: _from, to, ...fields } = populated;
    const tx = Transaction.from({
      ...fields,
      to: to == null ? null : await resolveAddress(to, this.provider),
    });
    const signed = await this.wallets.signTransaction(
      this.keyId,
      {
        type: tx.type,
        chainId: tx.chainId,
        nonce: tx.nonce,
        to: tx.to,
        gasLimit: tx.gasLimit,
        gasPrice: tx.gasPrice,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        data: tx.data,
        value: tx.value,
        accessList: tx.accessList,
      },
      await this.getAddress(),
    );
    // The deployment journal is durably updated before AbstractSigner broadcasts these bytes.
    if (this.onSigned) await this.onSigned(signed);
    return signed.signedTx;
  }

  override async signMessage(_message: string | Uint8Array): Promise<string> {
    throw new Error(
      "Personal-message signing is not enabled for the deployment signer.",
    );
  }

  override async signTypedData(
    _domain: TypedDataDomain,
    _types: Record<string, TypedDataField[]>,
    _value: Record<string, unknown>,
  ): Promise<string> {
    throw new Error(
      "Typed-data signing is not enabled for the deployment signer.",
    );
  }
}
