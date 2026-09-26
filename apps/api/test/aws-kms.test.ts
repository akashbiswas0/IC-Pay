import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  computeAddress,
  getBytes,
  hexlify,
  keccak256,
  randomBytes,
  recoverAddress,
  SigningKey,
  toBeHex,
  Transaction,
} from "ethers";
import {
  addressFromSpki,
  AwsKmsWallets,
  signatureFromDer,
} from "../src/aws-kms.js";

const ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
function derInteger(value: bigint) {
  let bytes = Buffer.from(getBytes(toBeHex(value)));
  if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([2, bytes.length]), bytes]);
}
function der(r: bigint, s: bigint) {
  const fields = Buffer.concat([derInteger(r), derInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, fields.length]), fields]);
}

test("KMS public key parser derives Ethereum address from a real secp256k1 SPKI", () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from(jwk.y!, "base64url"),
  ]);
  assert.equal(
    addressFromSpki(publicKey.export({ format: "der", type: "spki" })),
    computeAddress(hexlify(raw)).toLowerCase(),
  );
});

test("KMS public key parser rejects P-256, Ed25519, truncated, and trailing SPKI data", () => {
  for (const publicKey of [
    generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey,
    generateKeyPairSync("ed25519").publicKey,
  ]) {
    assert.throws(
      () => addressFromSpki(publicKey.export({ format: "der", type: "spki" })),
      /secp256k1/,
    );
  }
  const spki = generateKeyPairSync("ec", {
    namedCurve: "secp256k1",
  }).publicKey.export({ format: "der", type: "spki" });
  assert.throws(() => addressFromSpki(spki.subarray(0, spki.length - 1)));
  assert.throws(
    () => addressFromSpki(Buffer.concat([spki, Buffer.from([0])])),
    /canonical SPKI/,
  );
});

test("DER recovery preserves real ECDSA signatures and normalizes their high-S equivalent", () => {
  // These are real secp256k1 signatures over Ethereum digests; no KMS client is replaced.
  for (let i = 0; i < 16; i++) {
    const key = new SigningKey(randomBytes(32));
    const digest = keccak256(randomBytes(64));
    const signature = key.sign(digest);
    const address = computeAddress(key.publicKey);
    for (const s of [BigInt(signature.s), ORDER - BigInt(signature.s)]) {
      const recovered = signatureFromDer(
        digest,
        der(BigInt(signature.r), s),
        address,
      );
      assert.ok(BigInt(recovered.s) <= ORDER / 2n);
      assert.equal(recoverAddress(digest, recovered), address);
      assert.equal(recovered.serialized, signature.serialized);
    }
  }
});

test("DER signer binds the precise digest and expected key", () => {
  const key = new SigningKey(randomBytes(32));
  const digest = keccak256(randomBytes(32));
  const signature = key.sign(digest);
  const encoded = der(BigInt(signature.r), BigInt(signature.s));
  assert.throws(
    () =>
      signatureFromDer(
        keccak256(randomBytes(32)),
        encoded,
        computeAddress(key.publicKey),
      ),
    /expected wallet/,
  );
  assert.throws(
    () =>
      signatureFromDer(
        digest,
        encoded,
        computeAddress(new SigningKey(randomBytes(32)).publicKey),
      ),
    /expected wallet/,
  );
  assert.throws(
    () => signatureFromDer("0x1234", encoded, computeAddress(key.publicKey)),
    /32 bytes/,
  );
});

test("DER parser rejects zero/out-of-range scalars, signed integers, redundant padding and bad framing", () => {
  const key = new SigningKey(randomBytes(32));
  const digest = keccak256(randomBytes(32));
  const address = computeAddress(key.publicKey);
  const signature = key.sign(digest);
  const encoded = der(BigInt(signature.r), BigInt(signature.s));
  const malformed = [
    der(0n, 1n),
    der(1n, 0n),
    der(ORDER, 1n),
    der(1n, ORDER),
    Buffer.from("3006020180020101", "hex"), // negative r
    Buffer.from("300702020001020101", "hex"), // redundant r padding
    Buffer.from("30050200020101", "hex"), // empty integer
    Buffer.from("308106020101020101", "hex"), // long-form length is noncanonical for this sequence
    Buffer.from("3006020101020101ff", "hex"), // trailing data
    Buffer.from("3006020101030101", "hex"), // wrong tag
    encoded.subarray(0, encoded.length - 1),
    Buffer.concat([encoded, Buffer.from([0])]),
  ];
  for (const value of malformed)
    assert.throws(() => signatureFromDer(digest, value, address));
});

test("DER signatures produce valid legacy and EIP-1559 serialized Ethereum transactions", () => {
  const key = new SigningKey(randomBytes(32));
  const address = computeAddress(key.publicKey);
  for (const fee of [
    { type: 0, gasPrice: 1000000000n },
    { type: 2, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n },
  ]) {
    const tx = Transaction.from({
      ...fee,
      chainId: 31337,
      nonce: 7,
      to: address,
      value: 12n,
      gasLimit: 21000n,
    });
    const signature = key.sign(tx.unsignedHash);
    tx.signature = signatureFromDer(
      tx.unsignedHash,
      der(BigInt(signature.r), ORDER - BigInt(signature.s)),
      address,
    );
    const parsed = Transaction.from(tx.serialized);
    assert.equal(parsed.from, address);
    assert.equal(parsed.nonce, 7);
    assert.equal(parsed.chainId, 31337n);
    assert.equal(parsed.value, 12n);
    assert.equal(parsed.hash, keccak256(tx.serialized));
  }
});

test("AWS signer rejects incomplete transactions before any remote call", async () => {
  const wallet = new AwsKmsWallets("us-east-1");
  const valid = {
    type: 2,
    chainId: 31337,
    nonce: 0,
    gasLimit: 21000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  };
  await assert.rejects(
    wallet.signTransaction("unused", { ...valid, chainId: 0 }),
    /chain ID/,
  );
  await assert.rejects(
    wallet.signTransaction("unused", { ...valid, nonce: undefined }),
    /nonce/,
  );
  await assert.rejects(
    wallet.signTransaction("unused", {
      ...valid,
      nonce: Number.MAX_SAFE_INTEGER + 1,
    }),
    /nonce/,
  );
  await assert.rejects(
    wallet.signTransaction("unused", { ...valid, gasLimit: 0n }),
    /gas limit/,
  );
  await assert.rejects(
    wallet.signTransaction("unused", { ...valid, maxFeePerGas: undefined }),
    /fee parameters/,
  );
  await assert.rejects(wallet.recoverWallet("../invalid"), /wallet reference/);
});
