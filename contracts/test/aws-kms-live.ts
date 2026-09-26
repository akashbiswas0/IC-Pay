import { expect } from "chai";
import { network } from "hardhat";
import { NonceManager } from "ethers";
import { AwsKmsWallets } from "../../apps/api/src/aws-kms.js";
import { AwsKmsSigner } from "../scripts/aws-kms-signer.js";

const live = process.env.RUN_AWS_KMS_DEPLOYMENT_TEST === "1" ? it : it.skip;
describe("AWS KMS ethers deployment adapter (opt-in, existing key only)", () => {
  live(
    "deploys both real contracts to an isolated local EVM and journals before broadcasting",
    async function () {
      this.timeout(120000);
      const region = process.env.AWS_REGION;
      const keyId = process.env.AWS_KMS_OPERATOR_KEY_ID;
      if (!region || !keyId)
        throw new Error(
          "AWS_REGION and existing AWS_KMS_OPERATOR_KEY_ID are required.",
        );
      const { ethers } = await network.create();
      const chain = (await ethers.provider.getNetwork()).chainId;
      if (chain !== 31337n)
        throw new Error(
          "This live signing test must only broadcast to isolated Hardhat chain 31337.",
        );
      const wallets = new AwsKmsWallets(region);
      const owner = await wallets.address(keyId);
      await ethers.provider.send("hardhat_setBalance", [
        owner,
        "0x8ac7230489e80000",
      ]);
      const signedHashes: string[] = [];
      const signer = new NonceManager(
        new AwsKmsSigner(
          wallets,
          keyId,
          chain,
          ethers.provider,
          async (signed) => {
            expect(
              await ethers.provider.getTransactionReceipt(signed.hash),
            ).to.equal(null);
            signedHashes.push(signed.hash);
          },
        ),
      );
      const token = await (
        await ethers.getContractFactory("MatsuriStablecoin", signer)
      ).deploy("Matsuri Yen", "MJPY", owner);
      await token.waitForDeployment();
      const payments = await (
        await ethers.getContractFactory("DemoPayments", signer)
      ).deploy(await token.getAddress(), owner);
      await payments.waitForDeployment();
      expect((await token.owner()).toLowerCase()).to.equal(owner);
      expect(await payments.token()).to.equal(await token.getAddress());
      expect((await payments.owner()).toLowerCase()).to.equal(owner);
      expect(signedHashes).to.deep.equal([
        token.deploymentTransaction()!.hash,
        payments.deploymentTransaction()!.hash,
      ]);
      expect((await token.deploymentTransaction()!.wait())!.status).to.equal(1);
      expect((await payments.deploymentTransaction()!.wait())!.status).to.equal(
        1,
      );
      const wrongChain = new AwsKmsSigner(
        wallets,
        keyId,
        6497n,
        ethers.provider,
      );
      await expect(
        wrongChain.signTransaction({ to: owner, value: 0n }),
      ).to.be.rejectedWith("RPC chain does not match");
    },
  );
});
