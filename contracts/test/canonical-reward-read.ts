import { expect } from "chai";
import { network } from "hardhat";
import {
  CanonicalRewardReader,
  type RewardGetter,
} from "../../apps/api/src/reward-read.js";
const { ethers } = await network.create();

describe("Canonical reward read RPC uses actual immutable EVM block state", () => {
  it("reads the accepted historical campaign/NFT snapshot instead of latest state", async () => {
    const [owner, payer, recipient] = await ethers.getSigners();
    const token = await ethers.deployContract("MatsuriStablecoin", [
      "Matsuri Yen",
      "MJPY",
      owner.address,
    ]);
    const rewards = await ethers.deployContract("RewardPayments", [
      await token.getAddress(),
      owner.address,
    ]);
    const merchant = ethers.id("canonical-read-merchant");
    await (await rewards.setMerchant(merchant, recipient.address, true)).wait();
    await (
      await rewards.setCampaign(merchant, true, 100, 5000, 50, 3600)
    ).wait();
    await (await token.mint(payer.address, 1000)).wait();
    await (
      await token.connect(payer).approve(await rewards.getAddress(), 1000)
    ).wait();
    const latest = await ethers.provider.getBlock("latest");
    const minted = await (
      await rewards
        .connect(payer)
        .pay(
          ethers.id("canonical-read-invoice"),
          merchant,
          100,
          latest!.timestamp + 600,
        )
    ).wait();
    const accepted = await ethers.provider.getBlock(minted!.blockNumber);
    const anchor = { number: String(accepted!.number), hash: accepted!.hash! };
    await (
      await rewards.setCampaign(merchant, false, 100, 1000, 10, 120)
    ).wait();
    const reader = new CanonicalRewardReader(
      (method, params) => ethers.provider.send(method, params),
      "31337",
      await rewards.getAddress(),
    );
    const campaign = await reader.read("campaigns", [merchant], anchor);
    expect(campaign[0]).to.equal(true);
    expect(campaign[2]).to.equal("5000");
    const [ids, total] = await reader.read(
      "issuedVoucherIds",
      [payer.address, "0", "50"],
      anchor,
    );
    expect(ids).to.deep.equal(["1"]);
    expect(total).to.equal("1");
    const voucher = await reader.read("vouchers", ["1"], anchor);
    expect(voucher[1].toLowerCase()).to.equal(payer.address.toLowerCase());
    expect(voucher[8]).to.equal(false);
    const current = await ethers.provider.getBlock("latest");
    expect(
      (
        await reader.read("campaigns", [merchant], {
          number: String(current!.number),
          hash: current!.hash!,
        })
      )[0],
    ).to.equal(false);
  });
  it("rejects a different chain, incorrect canonical anchor and unsupported write method", async () => {
    const [owner] = await ethers.getSigners();
    const token = await ethers.deployContract("MatsuriStablecoin", [
      "Matsuri Yen",
      "MJPY",
      owner.address,
    ]);
    const rewards = await ethers.deployContract("RewardPayments", [
      await token.getAddress(),
      owner.address,
    ]);
    const block = await ethers.provider.getBlock("latest");
    const anchor = { number: String(block!.number), hash: block!.hash! };
    const rpc = (method: string, params: unknown[]) =>
      ethers.provider.send(method, params);
    const reader = new CanonicalRewardReader(
      rpc,
      "31337",
      await rewards.getAddress(),
    );
    let rejected = false;
    try {
      await new CanonicalRewardReader(
        rpc,
        "11155111",
        await rewards.getAddress(),
      ).read("nextVoucherId", [], anchor);
    } catch {
      rejected = true;
    }
    expect(rejected).to.equal(true);
    rejected = false;
    try {
      await reader.read("nextVoucherId", [], {
        ...anchor,
        hash: "0x" + "00".repeat(32),
      });
    } catch {
      rejected = true;
    }
    expect(rejected).to.equal(true);
    rejected = false;
    try {
      await reader.read("pay" as RewardGetter, [], anchor);
    } catch {
      rejected = true;
    }
    expect(rejected).to.equal(true);
  });
});
