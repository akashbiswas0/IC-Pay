import { expect } from "chai";
import { network } from "hardhat";
import { Transaction } from "ethers";
import { validateDeploymentQuote } from "../scripts/deploy-multibaas.js";

// A real in-process EVM prepares and executes compiled constructor transactions.
// The configured chain identifier exercises the production testnet allowlist; no public RPC is used.
const { ethers } = await network.create({ override: { chainId: 11155111 } });
async function creation() {
  const [deployer] = await ethers.getSigners();
  const factory = await ethers.getContractFactory(
    "MatsuriStablecoin",
    deployer,
  );
  const tx = await factory.getDeployTransaction(
    "Matsuri Yen",
    "MJPY",
    deployer.address,
  );
  const nonce = await deployer.getNonce();
  const fees = await ethers.provider.getFeeData();
  const gas = await deployer.estimateGas(tx);
  const expected = {
    chainId: "11155111",
    deployer: deployer.address,
    nonce,
    calldata: tx.data!,
  };
  const quote = {
    submitted: false,
    tx: {
      from: deployer.address,
      value: "0",
      data: tx.data!,
      nonce,
      gas: Number(gas),
      type: 2,
      gasFeeCap: fees.maxFeePerGas!.toString(),
      gasTipCap: fees.maxPriorityFeePerGas!.toString(),
    },
  };
  return { deployer, expected, quote };
}

describe("Deployment destination validation", () => {
  it("normalizes omitted and explicit null creation destinations to null", async () => {
    const { quote, expected } = await creation();
    for (const candidate of [
      quote,
      { ...quote, tx: { ...quote.tx, to: null } },
    ]) {
      const tx = Transaction.from(validateDeploymentQuote(candidate, expected));
      expect(tx.to).to.equal(null);
      expect(tx.data).to.equal(expected.calldata);
      expect(tx.chainId).to.equal(11155111n);
    }
  });
  it("rejects every actual recipient and non-null destination string before signing", async () => {
    const { quote, expected, deployer } = await creation();
    for (const to of [deployer.address, ethers.ZeroAddress, "", "0x"]) {
      expect(() =>
        validateDeploymentQuote(
          { ...quote, tx: { ...quote.tx, to } },
          expected,
        ),
      ).to.throw("Unsigned deployment does not match");
    }
  });
  it("deploys the real token from the validated omitted-destination transaction", async () => {
    const { quote, expected, deployer } = await creation();
    const tx = validateDeploymentQuote(quote, expected);
    const response = await deployer.sendTransaction(tx);
    const receipt = await response.wait();
    expect(receipt!.status).to.equal(1);
    const token = await ethers.getContractAt(
      "MatsuriStablecoin",
      receipt!.contractAddress!,
    );
    expect(await token.owner()).to.equal(deployer.address);
    expect(await token.symbol()).to.equal("MJPY");
  });
});
