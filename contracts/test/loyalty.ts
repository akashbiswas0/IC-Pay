import { expect } from "chai";
import { network } from "hardhat";
const { ethers } = await network.create();
const merchant = ethers.id("loyalty-shop"),
  other = ethers.id("other-loyalty-shop");
const units = (v: string) => ethers.parseEther(v),
  inv = (v: string) => ethers.id(v);
const DAY = 86400;
async function fixture() {
  const [admin, alice, recipient, bob, otherRecipient] =
    await ethers.getSigners();
  const token = await ethers.deployContract("MatsuriStablecoin", [
    "Matsuri Yen",
    "MJPY",
    admin.address,
  ]);
  const points = await ethers.deployContract("LoyaltyPoints", [
    await token.getAddress(),
    admin.address,
  ]);
  await points.setMerchant(merchant, recipient.address, true);
  await points.setMerchant(other, otherRecipient.address, true);
  await points.setCampaign(merchant, true, units("1"), 500, 50, 30 * DAY);
  await points.setCampaign(other, true, units("1"), 500, 50, 30 * DAY);
  for (const user of [alice, bob]) {
    await token.mint(user.address, units("10000"));
    await token
      .connect(user)
      .approve(await points.getAddress(), units("10000"));
  }
  await token
    .connect(recipient)
    .approve(await points.getAddress(), ethers.MaxUint256);
  await token
    .connect(otherRecipient)
    .approve(await points.getAddress(), ethers.MaxUint256);
  const deadline =
    (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
  return {
    admin,
    alice,
    bob,
    recipient,
    otherRecipient,
    token,
    points,
    deadline,
  };
}
async function pay(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  gross = "100",
  shop = merchant,
) {
  return f.points
    .connect(f.alice)
    .pay(inv(name), shop, units(gross), f.deadline);
}
async function balance(
  f: Awaited<ReturnType<typeof fixture>>,
  shop = merchant,
) {
  return f.points.pointsBalance(f.alice.address, shop);
}
async function nextTimestamp(at: number) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [at]);
  await ethers.provider.send("evm_mine", []);
}

describe("LoyaltyPoints real MJPY pooled accounting and refunds", () => {
  it("derives pointUnit, pools fractional earnings and caps each purchase", async () => {
    const f = await fixture();
    expect(await f.points.pointUnit()).eq(
      10n ** BigInt(await f.token.decimals()),
    );
    await pay(f, "17", "17");
    expect((await balance(f)).availablePoints).eq(0);
    expect((await balance(f)).fractionalUnits).eq(units("0.85"));
    await pay(f, "3", "3");
    expect((await balance(f)).availablePoints).eq(1);
    expect((await balance(f)).fractionalUnits).eq(0);
    await pay(f, "large", "2000");
    expect((await balance(f)).availablePoints).eq(51);
    const saved = await f.points.payments(f.alice.address, inv("17"));
    expect(saved.earnedUnits).eq(units("0.85"));
    expect(saved.campaignVersion).eq(1);
    expect(saved.earnBps).eq(500);
    expect(saved.maxEarnPoints).eq(50);
  });
  it("redeems exact whole points, earns on net, and never wastes a whole point on fractional gross", async () => {
    const f = await fixture();
    await pay(f, "earn");
    expect(
      await f.points.quotePoints(f.alice.address, merchant, units("2.5"), 10),
    ).deep.eq([2n, units("2"), units("0.5")]);
    await expect(
      f.points
        .connect(f.alice)
        .payWithPoints(inv("too-many"), merchant, units("2.5"), f.deadline, 3),
    ).revertedWithCustomError(f.points, "InvalidPointRedemption");
    const tx = await f.points
      .connect(f.alice)
      .payWithPoints(inv("use"), merchant, units("10"), f.deadline, 2);
    await expect(tx)
      .to.emit(f.points, "PointsRedeemed")
      .withArgs(inv("use"), merchant, f.alice.address, 2, units("2"));
    const p = await f.points.payments(f.alice.address, inv("use"));
    const oneLotReadGas = await f.points.pointsBalance.estimateGas(
      f.alice.address,
      merchant,
    );
    const oneLotPaymentGas = (await tx.wait())!.gasUsed;
    expect(oneLotReadGas).lt(100000n);
    expect(oneLotPaymentGas).lt(500000n);
    console.log(
      JSON.stringify({
        loyaltyOrdinary: {
          activeLots: 1,
          balanceReadGas: oneLotReadGas.toString(),
          paymentGas: oneLotPaymentGas.toString(),
        },
      }),
    );
    expect(p.netAmount).eq(units("8"));
    expect(p.earnedUnits).eq(units("0.4"));
    expect((await balance(f)).availablePoints).eq(3);
    expect((await balance(f)).fractionalUnits).eq(units("0.4"));
  });
  it("fully covers a payment with points, transfers no token and earns nothing", async () => {
    const f = await fixture();
    await pay(f, "earn");
    await f.token.connect(f.alice).approve(await f.points.getAddress(), 0);
    const tx = await f.points
      .connect(f.alice)
      .payWithPoints(inv("free"), merchant, units("5"), f.deadline, 5);
    await expect(tx)
      .to.emit(f.points, "PaymentCompleted")
      .withArgs(
        inv("free"),
        merchant,
        f.alice.address,
        f.recipient.address,
        await f.token.getAddress(),
        0,
      );
    const r = (await tx.wait())!;
    expect(r.logs.filter((l) => l.address === f.token.target)).length(0);
    expect(
      r.logs.filter(
        (l) =>
          l.topics[0] ===
          f.points.interface.getEvent("PointsEarned")!.topicHash,
      ),
    ).length(0);
    expect((await balance(f)).availablePoints).eq(0);
    await f.points.connect(f.recipient).refund(inv("free"), f.alice.address);
    expect((await balance(f)).availablePoints).eq(5);
  });
  it("isolates wallets/merchants, blocks replay and forbids merchant self-pay", async () => {
    const f = await fixture();
    await pay(f, "earn");
    expect((await balance(f, other)).availablePoints).eq(0);
    expect(
      (await f.points.pointsBalance(f.bob.address, merchant)).availablePoints,
    ).eq(0);
    await expect(
      f.points
        .connect(f.alice)
        .payWithPoints(inv("other"), other, units("1"), f.deadline, 1),
    ).revertedWithCustomError(f.points, "InsufficientPoints");
    await expect(pay(f, "earn")).revertedWithCustomError(
      f.points,
      "InvoiceAlreadySettled",
    );
    await f.points
      .connect(f.bob)
      .pay(inv("earn"), merchant, units("1"), f.deadline);
    await expect(
      f.points
        .connect(f.recipient)
        .pay(inv("self"), merchant, units("1"), f.deadline),
    ).revertedWithCustomError(f.points, "SelfPayment");
    await expect(
      f.points
        .connect(f.recipient)
        .payWithPoints(inv("self"), merchant, units("1"), f.deadline, 1),
    ).revertedWithCustomError(f.points, "SelfPayment");
  });
  it("atomically rolls point redemption and earning back if token allowance or balance is insufficient", async () => {
    const f = await fixture();
    await pay(f, "earn");
    const before = await balance(f);
    await f.token.connect(f.alice).approve(await f.points.getAddress(), 0);
    await expect(
      f.points
        .connect(f.alice)
        .payWithPoints(inv("retry"), merchant, units("10"), f.deadline, 2),
    ).revert(ethers);
    expect(await balance(f)).deep.eq(before);
    expect(await f.points.settled(f.alice.address, inv("retry"))).eq(false);
    await f.token
      .connect(f.alice)
      .approve(await f.points.getAddress(), units("10"));
    await f.token
      .connect(f.alice)
      .transfer(f.bob.address, await f.token.balanceOf(f.alice.address));
    await expect(
      f.points
        .connect(f.alice)
        .payWithPoints(inv("retry"), merchant, units("10"), f.deadline, 2),
    ).revert(ethers);
    expect(await balance(f)).deep.eq(before);
  });
  it("requires actual merchant token-return funding and rolls a failed refund back", async () => {
    const f = await fixture();
    await pay(f, "earn");
    for (const user of [f.alice, f.admin, f.otherRecipient])
      await expect(
        f.points.connect(user).refund(inv("earn"), f.alice.address),
      ).revertedWithCustomError(f.points, "UnauthorizedRefund");
    await f.token.connect(f.recipient).approve(await f.points.getAddress(), 0);
    await expect(
      f.points.connect(f.recipient).refund(inv("earn"), f.alice.address),
    ).revert(ethers);
    expect((await f.points.payments(f.alice.address, inv("earn"))).refunded).eq(
      false,
    );
    expect((await balance(f)).availablePoints).eq(5);
    await f.token
      .connect(f.recipient)
      .approve(await f.points.getAddress(), units("100"));
    const tx = await f.points
      .connect(f.recipient)
      .refund(inv("earn"), f.alice.address);
    await expect(tx)
      .to.emit(f.token, "Transfer")
      .withArgs(f.recipient.address, f.alice.address, units("100"));
    await expect(tx)
      .to.emit(f.points, "PaymentRefunded")
      .withArgs(
        inv("earn"),
        merchant,
        f.alice.address,
        f.recipient.address,
        await f.token.getAddress(),
        units("100"),
        0,
        units("5"),
        0,
      );
    expect((await balance(f)).availablePoints).eq(0);
    await expect(
      f.points.connect(f.recipient).refund(inv("earn"), f.alice.address),
    ).revertedWithCustomError(f.points, "AlreadyRefunded");
    await expect(pay(f, "earn")).revertedWithCustomError(
      f.points,
      "InvoiceAlreadySettled",
    );
  });
  it("records consumed-earning debt only for that merchant and repays it from later earning", async () => {
    const f = await fixture();
    await pay(f, "earn");
    await pay(f, "other-earn", "100", other);
    await f.points
      .connect(f.alice)
      .payWithPoints(inv("spend"), merchant, units("5"), f.deadline, 5);
    await f.points.connect(f.recipient).refund(inv("earn"), f.alice.address);
    expect((await balance(f)).debtUnits).eq(units("5"));
    expect((await balance(f, other)).availablePoints).eq(5);
    await pay(f, "repay", "100");
    expect((await balance(f)).availablePoints).eq(0);
    expect((await balance(f)).debtUnits).eq(0);
    expect(
      (await f.points.payments(f.alice.address, inv("repay"))).debtRepaid,
    ).eq(units("5"));
    await f.points.connect(f.recipient).refund(inv("repay"), f.alice.address);
    expect((await balance(f)).debtUnits).eq(units("5"));
    await f.points.connect(f.recipient).refund(inv("spend"), f.alice.address);
    expect((await balance(f)).debtUnits).eq(0);
    expect((await balance(f)).availablePoints).eq(0);
    const summary = await f.points.pointsSummary(f.alice.address, merchant);
    expect(
      summary.earnedUnits -
        summary.redeemedPoints * units("1") -
        summary.expiredUnits +
        summary.restoredUnits -
        summary.reversedUnits,
    ).eq(summary.activeUnits - summary.debtUnits);
  });
  it("reverses earnings before restoring redeemed lots, preserving pooled value on a mixed refund", async () => {
    const f = await fixture();
    await pay(f, "earn");
    await f.points
      .connect(f.alice)
      .payWithPoints(inv("mixed"), merchant, units("10"), f.deadline, 2);
    expect((await balance(f)).fractionalUnits).eq(units("0.4"));
    const tx = await f.points
      .connect(f.recipient)
      .refund(inv("mixed"), f.alice.address);
    await expect(tx)
      .to.emit(f.points, "PaymentRefunded")
      .withArgs(
        inv("mixed"),
        merchant,
        f.alice.address,
        f.recipient.address,
        await f.token.getAddress(),
        units("8"),
        units("2"),
        units("0.4"),
        0,
      );
    expect((await balance(f)).availablePoints).eq(5);
    expect((await balance(f)).fractionalUnits).eq(0);
  });
  it("rounds expiry up less than a day, materializes it without changing summary, and does not penalize expired unused earnings on refund", async () => {
    const f = await fixture();
    await f.points.setCampaign(merchant, true, units("1"), 500, 50, 60);
    const r = await (await pay(f, "short")).wait();
    const t = (await ethers.provider.getBlock(r!.blockNumber))!.timestamp;
    const p = await f.points.payments(f.alice.address, inv("short"));
    expect(p.earnedExpiresAt % BigInt(DAY)).eq(0);
    expect(p.earnedExpiresAt - BigInt(t))
      .gte(60n)
      .lt(BigInt(DAY + 60));
    await nextTimestamp(Number(p.earnedExpiresAt));
    expect((await balance(f)).availablePoints).eq(0);
    const before = await f.points.pointsSummary(f.alice.address, merchant);
    expect(before.expiredUnits).eq(units("5"));
    const slot = Number((p.earnedExpiresAt / BigInt(DAY)) % 367n);
    await expect(
      f.points.connect(f.bob).expirePoints(f.alice.address, merchant, slot, 1),
    )
      .to.emit(f.points, "PointsExpired")
      .withArgs(merchant, f.alice.address, units("5"));
    expect(await f.points.pointsSummary(f.alice.address, merchant)).deep.eq(
      before,
    );
    await f.points.connect(f.recipient).refund(inv("short"), f.alice.address);
    expect((await balance(f)).debtUnits).eq(0);
  });
  it("restores no expired spent points, preserves debt repayment reversal, and never extends expiry", async () => {
    const f = await fixture();
    await f.points.setCampaign(merchant, true, units("1"), 500, 50, 60);
    await pay(f, "earn");
    await f.points
      .connect(f.alice)
      .payWithPoints(inv("use"), merchant, units("5"), f.deadline, 5);
    const original = await f.points.payments(f.alice.address, inv("earn"));
    await f.points.connect(f.recipient).refund(inv("earn"), f.alice.address);
    expect((await balance(f)).debtUnits).eq(units("5"));
    await pay(f, "debt-repaid");
    expect((await balance(f)).debtUnits).eq(0);
    const repaid = await f.points.payments(f.alice.address, inv("debt-repaid"));
    await nextTimestamp(Number(repaid.earnedExpiresAt));
    await f.points.connect(f.recipient).refund(inv("use"), f.alice.address);
    expect((await balance(f)).availablePoints).eq(0);
    await f.points
      .connect(f.recipient)
      .refund(inv("debt-repaid"), f.alice.address);
    expect((await balance(f)).debtUnits).eq(units("5"));
    expect(original.earnedExpiresAt).eq(repaid.earnedExpiresAt);
  });
  it("documents merchant-approved post-expiry refund waiver for previously consumed points", async () => {
    const f = await fixture();
    await f.points.setCampaign(merchant, true, units("1"), 500, 50, 60);
    await pay(f, "earn");
    await f.points
      .connect(f.alice)
      .payWithPoints(inv("used"), merchant, units("5"), f.deadline, 5);
    const original = await f.points.payments(f.alice.address, inv("earn"));
    await nextTimestamp(Number(original.earnedExpiresAt));
    await f.points.connect(f.recipient).refund(inv("earn"), f.alice.address);
    expect((await balance(f)).debtUnits).eq(0); // Explicit approved policy; no additional late clawback.
    await f.points.connect(f.recipient).refund(inv("used"), f.alice.address);
    expect((await balance(f)).availablePoints).eq(0); // Original spent lots expired; no new points created.
    const summary = await f.points.pointsSummary(f.alice.address, merchant);
    expect(
      summary.earnedUnits -
        summary.redeemedPoints * units("1") -
        summary.expiredUnits +
        summary.restoredUnits -
        summary.reversedUnits,
    ).eq(summary.activeUnits - summary.debtUnits);
  });
  it("preserves campaign snapshots and honors old points after campaign pause but not merchant disable", async () => {
    const f = await fixture();
    await pay(f, "earn");
    const original = await f.points.payments(f.alice.address, inv("earn"));
    await f.points.setCampaign(merchant, false, units("1"), 1000, 10, 60);
    await pay(f, "paused");
    expect(
      (await f.points.payments(f.alice.address, inv("paused"))).earnedUnits,
    ).eq(0);
    expect(
      (await f.points.payments(f.alice.address, inv("earn"))).campaignVersion,
    ).eq(original.campaignVersion);
    await f.points
      .connect(f.alice)
      .payWithPoints(inv("allowed"), merchant, units("1"), f.deadline, 1);
    await f.points.setMerchant(merchant, f.recipient.address, false);
    await expect(
      f.points
        .connect(f.alice)
        .payWithPoints(inv("disabled"), merchant, units("1"), f.deadline, 1),
    ).revertedWithCustomError(f.points, "MerchantDisabled");
    await f.points.connect(f.recipient).refund(inv("allowed"), f.alice.address);
  });
  it("honors token precision, rejects >36 decimals and overflow campaigns, and explicitly floors sub-base-unit earning", async () => {
    const [owner, payer, recipient] = await ethers.getSigners();
    const six = await ethers.deployContract("DecimalToken", [6]);
    const points = await ethers.deployContract("LoyaltyPoints", [
      await six.getAddress(),
      owner.address,
    ]);
    expect(await points.pointUnit()).eq(1000000);
    const invalid = await ethers.deployContract("DecimalToken", [37]);
    await expect(
      ethers.deployContract("LoyaltyPoints", [
        await invalid.getAddress(),
        owner.address,
      ]),
    ).revertedWithCustomError(points, "InvalidToken");
    await points.setMerchant(merchant, recipient.address, true);
    await expect(
      points.setCampaign(merchant, true, 1, 500, ethers.MaxUint256, 60),
    ).revertedWithCustomError(points, "InvalidCampaign");
    await points.setCampaign(merchant, true, 1, 500, 50, 60);
    await six.mint(payer.address, 100);
    await six.connect(payer).approve(await points.getAddress(), 100);
    const end = (await ethers.provider.getBlock("latest"))!.timestamp + 1000;
    await points.connect(payer).pay(inv("tiny-19"), merchant, 19, end);
    expect(
      (await points.pointsBalance(payer.address, merchant)).fractionalUnits,
    ).eq(0);
    await points.connect(payer).pay(inv("tiny-20"), merchant, 20, end);
    expect(
      (await points.pointsBalance(payer.address, merchant)).fractionalUnits,
    ).eq(1);
  });
  it("bounds history pages and restricts campaign/merchant administration", async () => {
    const f = await fixture();
    await pay(f, "earn");
    await pay(f, "second", "1", other);
    expect(await f.points.walletMerchantIds(f.alice.address, 0, 50)).deep.eq([
      [merchant, other],
      2n,
    ]);
    expect(await f.points.merchantWallets(merchant, 0, 50)).deep.eq([
      [f.alice.address],
      1n,
    ]);
    await expect(
      f.points.walletMerchantIds(f.alice.address, 0, 51),
    ).revertedWithCustomError(f.points, "InvalidPageSize");
    await expect(
      f.points.expirePoints(f.alice.address, merchant, 367, 1),
    ).revertedWithCustomError(f.points, "InvalidBucket");
    await expect(
      f.points.connect(f.alice).setCampaign(merchant, true, 1, 500, 50, 60),
    ).revert(ethers);
    await expect(
      f.points.setMerchant(merchant, f.bob.address, true),
    ).revertedWithCustomError(f.points, "MerchantRecipientImmutable");
  });
  it("bounds worst-case 366-lot redemption/refund and reports actual EVM gas", async function () {
    this.timeout(120000);
    const f = await fixture();
    const latest = (await ethers.provider.getBlock("latest"))!.timestamp;
    await nextTimestamp((Math.floor(latest / DAY) + 2) * DAY + 1000);
    const deadline =
      (await ethers.provider.getBlock("latest"))!.timestamp + 400 * DAY;
    for (let i = 0; i < 366; i++) {
      await f.points.setCampaign(
        merchant,
        true,
        1,
        10000,
        50,
        i === 0 ? 60 : i * DAY,
      );
      await f.points
        .connect(f.alice)
        .pay(inv(`gas-${i}`), merchant, units("1"), deadline);
    }
    expect((await balance(f)).availablePoints).eq(366);
    const readGas = await f.points.pointsBalance.estimateGas(
      f.alice.address,
      merchant,
    );
    const payTx = await f.points
      .connect(f.alice)
      .payWithPoints(inv("gas-use"), merchant, units("366"), deadline, 366, {
        gasLimit: 16000000,
      });
    const redemption = (await payTx.wait())!.gasUsed;
    const refundTx = await f.points
      .connect(f.recipient)
      .refund(inv("gas-use"), f.alice.address, { gasLimit: 16000000 });
    const refund = (await refundTx.wait())!.gasUsed;
    expect((await balance(f)).availablePoints).eq(366);
    expect(redemption).lt(16000000n);
    expect(refund).lt(16000000n);
    expect(readGas).lt(2000000n);
    console.log(
      JSON.stringify({
        loyaltyWorstCase: {
          activeLots: 366,
          balanceReadGas: readGas.toString(),
          redemptionGas: redemption.toString(),
          refundGas: refund.toString(),
        },
      }),
    );
  });
});
