import { expect } from "chai";
import { network } from "hardhat";
import { CanonicalRewardReader } from "../../apps/api/src/reward-read.js";
const { ethers } = await network.create();
const art =
  "https://main.d21bivg674x6ke.amplifyapp.com/nft-art/real-contract-test/";

describe("Canonical collectible reader against real immutable EVM states", () => {
  it("decodes credit and metadata at low numbered issue, partial-use and exhausted blocks while retaining NFT ownership", async () => {
    const [owner, payer, merchantWallet] = await ethers.getSigners();
    const token = await ethers.deployContract("MatsuriStablecoin", [
      "Matsuri Yen",
      "MJPY",
      owner.address,
    ]);
    const rewards = await ethers.deployContract("CollectibleRewards", [
      await token.getAddress(),
      owner.address,
      art,
    ]);
    const merchant = ethers.id("canonical-collectible-merchant");
    await rewards.setMerchant(merchant, merchantWallet.address, true);
    await rewards.setCampaign(merchant, true, 1, 500, 50, 3600);
    await token.mint(payer.address, 1000);
    await token.connect(payer).approve(await rewards.getAddress(), 1000);
    const deadline =
      (await ethers.provider.getBlock("latest"))!.timestamp + 600;
    const receipt = await (
      await rewards
        .connect(payer)
        .pay(ethers.id("credit-earned"), merchant, 100, deadline)
    ).wait();
    expect(receipt!.blockNumber).lessThan(16);
    async function anchor(number: number) {
      const b = (await ethers.provider.getBlock(number))!;
      return { number: String(b.number), hash: b.hash! };
    }
    const issued = await anchor(receipt!.blockNumber);
    const reader = new CanonicalRewardReader(
      (method, args) => ethers.provider.send(method, args),
      "31337",
      await rewards.getAddress(),
      "collectibles",
    );
    const campaign = await reader.read("campaigns", [merchant], issued);
    expect(campaign).deep.eq([true, "1", "500", "50", "3600", "1"]);
    const original = await reader.read("vouchers", ["1"], issued);
    expect(original).length(14);
    expect(original.slice(2, 8)).deep.eq(["100", "5", "5", "500", "50", "1"]);
    expect(original[10]).eq(false);
    expect(original[12]).eq(ethers.id("credit-earned"));
    await token.connect(payer).approve(await rewards.getAddress(), 0);
    const partialReceipt = await (
      await rewards
        .connect(payer)
        .payWithReward(ethers.id("credit-partial"), merchant, 2, deadline, 1)
    ).wait();
    const partial = await anchor(partialReceipt!.blockNumber);
    const partialVoucher = await reader.read("vouchers", ["1"], partial);
    expect(partialVoucher[4]).eq("3");
    expect(partialVoucher[10]).eq(false);
    const finalReceipt = await (
      await rewards
        .connect(payer)
        .payWithReward(ethers.id("credit-exhausted"), merchant, 3, deadline, 1)
    ).wait();
    const final = await anchor(finalReceipt!.blockNumber);
    const used = await reader.read("vouchers", ["1"], final);
    expect(used[3]).eq("5");
    expect(used[4]).eq("0");
    expect(used[10]).eq(true);
    expect(used[13]).eq(ethers.id("credit-exhausted"));
    expect(await rewards.ownerOf(1)).eq(payer.address);
    expect(
      await reader.read("issuedVoucherIds", [payer.address, "0", "50"], final),
    ).deep.eq([["1"], "1"]);
    for (const [block, status, remaining] of [
      [issued, "available", "5"],
      [partial, "available", "3"],
      [final, "redeemed", "0"],
    ] as const) {
      const [uri] = await reader.read("tokenURI", ["1"], block);
      const metadata = JSON.parse(
        Buffer.from(uri.split(",")[1], "base64").toString(),
      );
      expect(metadata.image).eq(art + "1.jpg");
      expect(
        metadata.attributes.find((a: any) => a.trait_type === "Status").value,
      ).eq(status);
      expect(
        metadata.attributes.find(
          (a: any) => a.trait_type === "Remaining credit base units",
        ).value,
      ).eq(remaining);
    }
    // Later redemptions cannot alter historical EIP-1898 reads.
    expect(await reader.read("vouchers", ["1"], issued)).deep.eq(original);
    expect(await reader.read("vouchers", ["1"], partial)).deep.eq(
      partialVoucher,
    );
  });
});
