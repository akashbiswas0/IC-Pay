import { expect } from "chai";
import { network } from "hardhat";
import { NonceManager, Transaction } from "ethers";
import { KMSClient } from "@aws-sdk/client-kms";
import { AwsKmsWallets } from "../../apps/api/src/aws-kms.js";
import { AwsKmsSigner } from "../scripts/aws-kms-signer.js";

const live = process.env.RUN_AWS_KMS_REWARDS_TEST === "1" ? it : it.skip;
describe("Real AWS KMS reward lifecycle on isolated local EVM (opt-in)", () => {
  live(
    "earns and redeems a real NFT with KMS-signed transactions and exact net/burn receipts",
    async function () {
      this.timeout(180000);
      const keyId = process.env.AWS_KMS_OPERATOR_KEY_ID;
      if (!keyId)
        throw new Error(
          "An existing AWS_KMS_OPERATOR_KEY_ID is required; this test never creates keys.",
        );
      const { ethers } = await network.create();
      const chain = (await ethers.provider.getNetwork()).chainId;
      if (chain !== 31337n)
        throw new Error(
          "Reward smoke must only broadcast to fresh local Hardhat chain31337.",
        );
      const regionClient = new KMSClient({});
      const region =
        process.env.AWS_REGION ?? (await regionClient.config.region());
      regionClient.destroy();
      const wallets = new AwsKmsWallets(region);
      const operator = await wallets.address(keyId);
      const [genesis, merchant] = await ethers.getSigners();
      // A genuine local genesis-account transfer supplies gas, rather than overriding an account balance.
      const gasFunding = await genesis.sendTransaction({
        to: operator,
        value: ethers.parseEther("2"),
      });
      expect((await gasFunding.wait())!.status).to.equal(1);
      expect(await ethers.provider.getBalance(operator)).to.equal(
        ethers.parseEther("2"),
      );
      const signedHashes: string[] = [];
      const signer = new NonceManager(
        new AwsKmsSigner(
          wallets,
          keyId,
          31337n,
          ethers.provider,
          async (signed) => {
            const tx = Transaction.from(signed.signedTx);
            expect(tx.chainId).to.equal(31337n);
            expect(tx.from!.toLowerCase()).to.equal(operator);
            expect(tx.hash).to.equal(signed.hash);
            signedHashes.push(signed.hash);
          },
        ),
      );
      const token = await (
        await ethers.getContractFactory("MatsuriStablecoin", signer)
      ).deploy("Matsuri Yen", "MJPY", operator);
      await token.waitForDeployment();
      const rewards = await (
        await ethers.getContractFactory("RewardPayments", signer)
      ).deploy(await token.getAddress(), operator);
      await rewards.waitForDeployment();
      const merchantId = ethers.id("local-kms-reward-merchant");
      const mjpy = (value: string) => ethers.parseUnits(value, 18);
      await (
        await rewards.setMerchant(merchantId, merchant.address, true)
      ).wait();
      await (
        await rewards.setCampaign(
          merchantId,
          true,
          mjpy("100"),
          5000,
          mjpy("50"),
          30 * 86400,
        )
      ).wait();
      await (await token.mint(operator, mjpy("1000"))).wait();
      await (
        await token.approve(await rewards.getAddress(), mjpy("300"))
      ).wait();
      const deadline =
        (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
      const earnInvoice = ethers.id("local-kms-earn");
      const earn = await rewards.pay(
        earnInvoice,
        merchantId,
        mjpy("100"),
        deadline,
      );
      const earnedReceipt = await earn.wait();
      expect(earnedReceipt!.status).to.equal(1);
      expect((await rewards.ownerOf(1)).toLowerCase()).to.equal(operator);
      await expect(earn).to.emit(rewards, "RewardIssued");
      expect(await rewards.balanceOf(operator)).to.equal(1n);
      const quote = await rewards.quoteReward(
        1,
        operator,
        merchantId,
        mjpy("80"),
      );
      expect(quote.discount).to.equal(mjpy("40"));
      expect(quote.netAmount).to.equal(mjpy("40"));
      const redeemInvoice = ethers.id("local-kms-redeem");
      const redeem = await rewards.payWithReward(
        redeemInvoice,
        merchantId,
        mjpy("80"),
        deadline,
        1,
      );
      const redeemedReceipt = await redeem.wait();
      expect(redeemedReceipt!.status).to.equal(1);
      await expect(redeem)
        .to.emit(rewards, "PaymentCompleted")
        .withArgs(
          redeemInvoice,
          merchantId,
          ethers.getAddress(operator),
          merchant.address,
          await token.getAddress(),
          mjpy("40"),
        );
      await expect(redeem)
        .to.emit(rewards, "RewardRedeemed")
        .withArgs(
          1,
          ethers.getAddress(operator),
          merchantId,
          redeemInvoice,
          mjpy("80"),
          mjpy("40"),
          mjpy("40"),
        );
      await expect(redeem)
        .to.emit(rewards, "Transfer")
        .withArgs(ethers.getAddress(operator), ethers.ZeroAddress, 1);
      await expect(redeem).not.to.emit(rewards, "RewardIssued");
      expect(await token.balanceOf(operator)).to.equal(mjpy("860"));
      expect(await token.balanceOf(merchant.address)).to.equal(mjpy("140"));
      expect(
        await token.allowance(operator, await rewards.getAddress()),
      ).to.equal(mjpy("160"));
      expect(await rewards.balanceOf(operator)).to.equal(0n);
      expect(await rewards.nextVoucherId()).to.equal(2n);
      expect((await rewards.vouchers(1)).redeemed).to.equal(true);
      expect((await rewards.vouchers(1)).redeemedInvoiceId).to.equal(
        redeemInvoice,
      );
      expect(await rewards.settled(operator, earnInvoice)).to.equal(true);
      expect(await rewards.settled(operator, redeemInvoice)).to.equal(true);
      expect(signedHashes).to.have.length(8);
      expect(new Set(signedHashes).size).to.equal(8);
      expect(await ethers.provider.getTransactionCount(operator)).to.equal(8);
    },
  );
});
