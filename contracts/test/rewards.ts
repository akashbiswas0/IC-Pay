import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();
const merchantId = ethers.id("reward-merchant");
const otherMerchantId = ethers.id("other-reward-merchant");
const earnedInvoice = ethers.id("earned-reward");
const redeemInvoice = ethers.id("redeemed-reward");
const mjpy = (amount: string) => ethers.parseUnits(amount, 18);
const validity = 30 * 24 * 3600;

async function fixture() {
  const [admin, alice, recipient, bob, secondRecipient] =
    await ethers.getSigners();
  const token = await ethers.deployContract("MatsuriStablecoin", [
    "Matsuri Yen",
    "MJPY",
    admin.address,
  ]);
  const rewards = await ethers.deployContract("RewardPayments", [
    await token.getAddress(),
    admin.address,
  ]);
  await rewards.setMerchant(merchantId, recipient.address, true);
  await rewards.setMerchant(otherMerchantId, secondRecipient.address, true);
  await rewards.setCampaign(
    merchantId,
    true,
    mjpy("100"),
    5000,
    mjpy("50"),
    validity,
  );
  for (const payer of [alice, bob]) {
    await token.mint(payer.address, mjpy("1000"));
    await token
      .connect(payer)
      .approve(await rewards.getAddress(), mjpy("1000"));
  }
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
  return {
    admin,
    alice,
    recipient,
    bob,
    secondRecipient,
    token,
    rewards,
    deadline,
  };
}
async function earn(f: Awaited<ReturnType<typeof fixture>>) {
  await f.rewards
    .connect(f.alice)
    .pay(earnedInvoice, merchantId, mjpy("100"), f.deadline);
  return f.rewards.vouchers(1);
}

describe("RewardPayments with real MJPY and non-transferable ERC721 vouchers", () => {
  it("atomically charges a qualifying purchase and issues a fully snapshotted voucher", async () => {
    const f = await fixture();
    const tx = await f.rewards
      .connect(f.alice)
      .pay(earnedInvoice, merchantId, mjpy("100"), f.deadline);
    const receipt = await tx.wait();
    const issuedAt = (await ethers.provider.getBlock(receipt!.blockNumber))!
      .timestamp;
    await expect(tx)
      .to.emit(f.rewards, "PaymentCompleted")
      .withArgs(
        earnedInvoice,
        merchantId,
        f.alice.address,
        f.recipient.address,
        await f.token.getAddress(),
        mjpy("100"),
      );
    await expect(tx)
      .to.emit(f.rewards, "RewardIssued")
      .withArgs(
        1n,
        f.alice.address,
        merchantId,
        earnedInvoice,
        1n,
        mjpy("100"),
        5000,
        mjpy("50"),
        issuedAt + validity,
      );
    expect(await f.rewards.ownerOf(1)).to.equal(f.alice.address);
    expect(await f.rewards.balanceOf(f.alice.address)).to.equal(1n);
    expect(await f.token.balanceOf(f.alice.address)).to.equal(mjpy("900"));
    const v = await f.rewards.vouchers(1);
    expect(v.holder).to.equal(f.alice.address);
    expect(v.merchantId).to.equal(merchantId);
    expect(v.issuedInvoiceId).to.equal(earnedInvoice);
    expect(v.minPurchase).to.equal(mjpy("100"));
    expect(v.issuedAt).to.equal(BigInt(issuedAt));
    expect(v.redeemed).to.equal(false);
    expect(await f.rewards.supportsInterface("0x80ac58cd")).to.equal(true);
  });

  it("allows normal purchases below the earning threshold without fabricating a reward", async () => {
    const f = await fixture();
    expect(await f.rewards.quotePayment(merchantId, mjpy("99"))).to.deep.equal([
      false,
      1n,
    ]);
    expect(await f.rewards.quotePayment(merchantId, mjpy("100"))).to.deep.equal(
      [true, 1n],
    );
    await f.rewards
      .connect(f.alice)
      .pay(earnedInvoice, merchantId, mjpy("99"), f.deadline);
    expect(await f.rewards.balanceOf(f.alice.address)).to.equal(0n);
    expect(await f.rewards.nextVoucherId()).to.equal(1n);
    expect(await f.token.balanceOf(f.recipient.address)).to.equal(mjpy("99"));
  });

  it("caps discounts, emits actual net charge, burns once, and never earns recursively", async () => {
    const f = await fixture();
    await earn(f);
    expect(
      await f.rewards.quoteReward(1, f.alice.address, merchantId, mjpy("200")),
    ).to.deep.equal([mjpy("50"), mjpy("150")]);
    const tx = await f.rewards
      .connect(f.alice)
      .payWithReward(redeemInvoice, merchantId, mjpy("200"), f.deadline, 1);
    await expect(tx)
      .to.emit(f.rewards, "PaymentCompleted")
      .withArgs(
        redeemInvoice,
        merchantId,
        f.alice.address,
        f.recipient.address,
        await f.token.getAddress(),
        mjpy("150"),
      );
    await expect(tx)
      .to.emit(f.rewards, "RewardRedeemed")
      .withArgs(
        1,
        f.alice.address,
        merchantId,
        redeemInvoice,
        mjpy("200"),
        mjpy("50"),
        mjpy("150"),
      );
    await expect(tx).not.to.emit(f.rewards, "RewardIssued");
    expect(await f.rewards.balanceOf(f.alice.address)).to.equal(0n);
    expect(await f.rewards.nextVoucherId()).to.equal(2n);
    expect(await f.token.balanceOf(f.alice.address)).to.equal(mjpy("750"));
    expect(await f.token.balanceOf(f.recipient.address)).to.equal(mjpy("250"));
    await expect(f.rewards.ownerOf(1)).to.be.revertedWithCustomError(
      f.rewards,
      "ERC721NonexistentToken",
    );
    const v = await f.rewards.vouchers(1);
    expect(v.holder).to.equal(f.alice.address);
    expect(v.redeemed).to.equal(true);
    expect(v.redeemedInvoiceId).to.equal(redeemInvoice);
    expect(v.redeemedAt).to.be.greaterThanOrEqual(v.issuedAt);
  });

  it("redeems a smaller later purchase without applying the original earning threshold", async () => {
    const f = await fixture();
    await earn(f);
    expect(
      await f.rewards.quoteReward(1, f.alice.address, merchantId, mjpy("10")),
    ).to.deep.equal([mjpy("5"), mjpy("5")]);
    await f.rewards
      .connect(f.alice)
      .payWithReward(redeemInvoice, merchantId, mjpy("10"), f.deadline, 1);
    expect(await f.token.balanceOf(f.recipient.address)).to.equal(mjpy("105"));
  });

  it("rejects wrong holders, wrong merchants, unknown vouchers and zero gross amounts", async () => {
    const f = await fixture();
    await earn(f);
    await expect(
      f.rewards
        .connect(f.bob)
        .payWithReward(redeemInvoice, merchantId, mjpy("10"), f.deadline, 1),
    ).to.be.revertedWithCustomError(f.rewards, "WrongVoucherHolder");
    await expect(
      f.rewards
        .connect(f.alice)
        .payWithReward(
          redeemInvoice,
          otherMerchantId,
          mjpy("10"),
          f.deadline,
          1,
        ),
    ).to.be.revertedWithCustomError(f.rewards, "WrongVoucherMerchant");
    await expect(
      f.rewards.quoteReward(999, f.alice.address, merchantId, mjpy("10")),
    ).to.be.revertedWithCustomError(f.rewards, "VoucherUnavailable");
    await expect(
      f.rewards.quoteReward(1, f.alice.address, merchantId, 0),
    ).to.be.revertedWithCustomError(f.rewards, "InvalidAmount");
    expect((await f.rewards.vouchers(1)).redeemed).to.equal(false);
  });

  it("makes vouchers non-transferable and refuses delegated approvals", async () => {
    const f = await fixture();
    await earn(f);
    await expect(
      f.rewards
        .connect(f.alice)
        .transferFrom(f.alice.address, f.bob.address, 1),
    ).to.be.revertedWithCustomError(f.rewards, "NonTransferable");
    await expect(
      f.rewards
        .connect(f.alice)
        ["safeTransferFrom(address,address,uint256)"](
          f.alice.address,
          f.bob.address,
          1,
        ),
    ).to.be.revertedWithCustomError(f.rewards, "NonTransferable");
    await expect(
      f.rewards.connect(f.alice).approve(f.bob.address, 1),
    ).to.be.revertedWithCustomError(f.rewards, "NonTransferable");
    await expect(
      f.rewards.connect(f.alice).setApprovalForAll(f.bob.address, true),
    ).to.be.revertedWithCustomError(f.rewards, "NonTransferable");
    await expect(
      f.rewards
        .connect(f.admin)
        .payWithReward(redeemInvoice, merchantId, mjpy("10"), f.deadline, 1),
    ).to.be.revertedWithCustomError(f.rewards, "WrongVoucherHolder");
  });

  it("preserves issued terms and campaign versions after edits, including disabling issuance", async () => {
    const f = await fixture();
    const original = await earn(f);
    await f.rewards.setCampaign(
      merchantId,
      false,
      mjpy("200"),
      1000,
      mjpy("5"),
      60,
    );
    const snapshot = await f.rewards.vouchers(1);
    expect(snapshot).to.deep.equal(original);
    expect((await f.rewards.campaigns(merchantId)).version).to.equal(2n);
    expect(await f.rewards.quotePayment(merchantId, mjpy("300"))).to.deep.equal(
      [false, 2n],
    );
    await f.rewards
      .connect(f.alice)
      .pay(ethers.id("disabled-campaign"), merchantId, mjpy("200"), f.deadline);
    expect(await f.rewards.nextVoucherId()).to.equal(2n);
    expect(
      await f.rewards.quoteReward(1, f.alice.address, merchantId, mjpy("20")),
    ).to.deep.equal([mjpy("10"), mjpy("10")]);
    await f.rewards
      .connect(f.alice)
      .payWithReward(redeemInvoice, merchantId, mjpy("20"), f.deadline, 1);
    expect((await f.rewards.vouchers(1)).campaignVersion).to.equal(1n);
  });

  it("honors voucher expiry including the exact expiry boundary", async () => {
    const f = await fixture();
    const v = await earn(f);
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(v.expiresAt),
    ]);
    await ethers.provider.send("evm_mine", []);
    expect(
      await f.rewards.quoteReward(1, f.alice.address, merchantId, mjpy("10")),
    ).to.deep.equal([mjpy("5"), mjpy("5")]);
    await expect(
      f.rewards
        .connect(f.alice)
        .payWithReward(
          redeemInvoice,
          merchantId,
          mjpy("10"),
          v.expiresAt + 3600n,
          1,
        ),
    ).to.be.revertedWithCustomError(f.rewards, "VoucherExpired");
    expect(await f.rewards.ownerOf(1)).to.equal(f.alice.address);
  });

  it("blocks disabled merchants and cannot redirect an issued merchant reward", async () => {
    const f = await fixture();
    await earn(f);
    await expect(
      f.rewards.setMerchant(merchantId, f.secondRecipient.address, true),
    ).to.be.revertedWithCustomError(f.rewards, "MerchantRecipientImmutable");
    await f.rewards.setMerchant(merchantId, f.recipient.address, false);
    await expect(
      f.rewards
        .connect(f.alice)
        .payWithReward(redeemInvoice, merchantId, mjpy("10"), f.deadline, 1),
    ).to.be.revertedWithCustomError(f.rewards, "MerchantDisabled");
    await expect(
      f.rewards
        .connect(f.alice)
        .pay(ethers.id("disabled"), merchantId, mjpy("100"), f.deadline),
    ).to.be.revertedWithCustomError(f.rewards, "MerchantDisabled");
  });

  it("prevents duplicate invoices and duplicate redemption without consuming another reward", async () => {
    const f = await fixture();
    await earn(f);
    await expect(
      f.rewards
        .connect(f.alice)
        .pay(earnedInvoice, merchantId, mjpy("100"), f.deadline),
    ).to.be.revertedWithCustomError(f.rewards, "InvoiceAlreadySettled");
    await expect(
      f.rewards
        .connect(f.alice)
        .payWithReward(earnedInvoice, merchantId, mjpy("10"), f.deadline, 1),
    ).to.be.revertedWithCustomError(f.rewards, "InvoiceAlreadySettled");
    await f.rewards
      .connect(f.alice)
      .payWithReward(redeemInvoice, merchantId, mjpy("10"), f.deadline, 1);
    await expect(
      f.rewards
        .connect(f.alice)
        .payWithReward(
          ethers.id("second-redemption"),
          merchantId,
          mjpy("10"),
          f.deadline,
          1,
        ),
    ).to.be.revertedWithCustomError(f.rewards, "VoucherUnavailable");
    expect(await f.rewards.nextVoucherId()).to.equal(2n);
  });

  it("keeps invoice settlement payer-scoped", async () => {
    const f = await fixture();
    await earn(f);
    await f.rewards
      .connect(f.bob)
      .pay(earnedInvoice, merchantId, mjpy("100"), f.deadline);
    expect(await f.rewards.ownerOf(1)).to.equal(f.alice.address);
    expect(await f.rewards.ownerOf(2)).to.equal(f.bob.address);
  });

  it("rolls back the voucher burn and invoice on insufficient allowance, then permits a funded retry", async () => {
    const f = await fixture();
    await earn(f);
    await f.token
      .connect(f.alice)
      .approve(await f.rewards.getAddress(), mjpy("5") - 1n);
    await expect(
      f.rewards
        .connect(f.alice)
        .payWithReward(redeemInvoice, merchantId, mjpy("10"), f.deadline, 1),
    ).to.be.revertedWithCustomError(f.token, "ERC20InsufficientAllowance");
    expect(await f.rewards.ownerOf(1)).to.equal(f.alice.address);
    expect((await f.rewards.vouchers(1)).redeemed).to.equal(false);
    expect(await f.rewards.settled(f.alice.address, redeemInvoice)).to.equal(
      false,
    );
    expect(await f.token.balanceOf(f.recipient.address)).to.equal(mjpy("100"));
    await f.token
      .connect(f.alice)
      .approve(await f.rewards.getAddress(), mjpy("5"));
    await f.rewards
      .connect(f.alice)
      .payWithReward(redeemInvoice, merchantId, mjpy("10"), f.deadline, 1);
    expect((await f.rewards.vouchers(1)).redeemed).to.equal(true);
  });

  it("rolls back redemption and allowance on insufficient balance", async () => {
    const f = await fixture();
    await earn(f);
    const allowance = await f.token.allowance(
      f.alice.address,
      await f.rewards.getAddress(),
    );
    await f.token.burn(
      f.alice.address,
      await f.token.balanceOf(f.alice.address),
    );
    await expect(
      f.rewards
        .connect(f.alice)
        .payWithReward(redeemInvoice, merchantId, mjpy("10"), f.deadline, 1),
    ).to.be.revertedWithCustomError(f.token, "ERC20InsufficientBalance");
    expect(await f.rewards.ownerOf(1)).to.equal(f.alice.address);
    expect((await f.rewards.vouchers(1)).redeemedInvoiceId).to.equal(
      ethers.ZeroHash,
    );
    expect(await f.rewards.settled(f.alice.address, redeemInvoice)).to.equal(
      false,
    );
    expect(
      await f.token.allowance(f.alice.address, await f.rewards.getAddress()),
    ).to.equal(allowance);
  });

  it("does not issue a reward if a full-price payment fails", async () => {
    const f = await fixture();
    await f.token.connect(f.alice).approve(await f.rewards.getAddress(), 0);
    await expect(
      f.rewards
        .connect(f.alice)
        .pay(earnedInvoice, merchantId, mjpy("100"), f.deadline),
    ).to.be.revertedWithCustomError(f.token, "ERC20InsufficientAllowance");
    expect(await f.rewards.nextVoucherId()).to.equal(1n);
    expect(await f.rewards.settled(f.alice.address, earnedInvoice)).to.equal(
      false,
    );
    expect(await f.rewards.balanceOf(f.alice.address)).to.equal(0n);
  });

  it("rounds down safely, rejects zero rounded discounts, and always charges a positive net", async () => {
    const f = await fixture();
    await f.rewards.setCampaign(
      merchantId,
      true,
      1,
      9999,
      mjpy("50"),
      validity,
    );
    await f.rewards
      .connect(f.alice)
      .pay(earnedInvoice, merchantId, 1, f.deadline);
    await expect(
      f.rewards.quoteReward(1, f.alice.address, merchantId, 1),
    ).to.be.revertedWithCustomError(f.rewards, "ZeroDiscount");
    expect(
      await f.rewards.quoteReward(1, f.alice.address, merchantId, 2),
    ).to.deep.equal([1n, 1n]);
    const huge = await f.rewards.quoteReward(
      1,
      f.alice.address,
      merchantId,
      ethers.MaxUint256,
    );
    expect(huge.discount).to.equal(mjpy("50"));
    expect(huge.netAmount).to.equal(ethers.MaxUint256 - mjpy("50"));
  });

  it("retains metadata and bounded issued history after burn", async () => {
    const f = await fixture();
    await earn(f);
    await f.rewards
      .connect(f.alice)
      .pay(ethers.id("second-earned"), merchantId, mjpy("100"), f.deadline);
    await f.rewards
      .connect(f.alice)
      .payWithReward(redeemInvoice, merchantId, mjpy("10"), f.deadline, 1);
    const first = await f.rewards.issuedVoucherIds(f.alice.address, 0, 1);
    expect(first.voucherIds).to.deep.equal([1n]);
    expect(first.total).to.equal(2n);
    expect(
      (await f.rewards.issuedVoucherIds(f.alice.address, 1, 50)).voucherIds,
    ).to.deep.equal([2n]);
    expect(
      (await f.rewards.issuedVoucherIds(f.alice.address, ethers.MaxUint256, 50))
        .voucherIds,
    ).to.deep.equal([]);
    await expect(
      f.rewards.issuedVoucherIds(f.alice.address, 0, 0),
    ).to.be.revertedWithCustomError(f.rewards, "InvalidPageSize");
    await expect(
      f.rewards.issuedVoucherIds(f.alice.address, 0, 51),
    ).to.be.revertedWithCustomError(f.rewards, "InvalidPageSize");
    const uri = await f.rewards.tokenURI(1);
    const metadata = JSON.parse(
      Buffer.from(uri.split(",")[1], "base64").toString(),
    );
    expect(
      metadata.attributes.find(
        (a: { trait_type: string }) => a.trait_type === "Status",
      ).value,
    ).to.equal("redeemed");
    await expect(f.rewards.tokenURI(999)).to.be.revertedWithCustomError(
      f.rewards,
      "ERC721NonexistentToken",
    );
  });

  it("enforces campaign administration and valid positive bounded terms", async () => {
    const f = await fixture();
    await expect(
      f.rewards.connect(f.alice).setCampaign(merchantId, true, 1, 5000, 1, 1),
    ).to.be.revertedWithCustomError(f.rewards, "OwnableUnauthorizedAccount");
    for (const [min, bps, cap, seconds] of [
      [0, 5000, 1, 1],
      [1, 0, 1, 1],
      [1, 10000, 1, 1],
      [1, 5000, 0, 1],
      [1, 5000, 1, 0],
      [1, 5000, 1, 365 * 86400 + 1],
    ]) {
      await expect(
        f.rewards.setCampaign(merchantId, true, min, bps, cap, seconds),
      ).to.be.revertedWithCustomError(f.rewards, "InvalidCampaign");
    }
    await expect(
      f.rewards.setCampaign(ethers.id("unknown"), true, 1, 5000, 1, 1),
    ).to.be.revertedWithCustomError(f.rewards, "InvalidMerchant");
  });
});
