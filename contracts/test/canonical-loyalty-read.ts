import { expect } from "chai";
import { network } from "hardhat";
import { randomUUID } from "node:crypto";
import { CanonicalRewardReader } from "../../apps/api/src/reward-read.js";
import { config } from "../../apps/api/src/config.js";
import { validateLoyaltyReceipt } from "../../apps/api/src/loyalty.js";
import { refundReceiptMatches } from "../../apps/api/src/loyalty-refunds.js";
const { ethers } = await network.create();
const paymentFields = [
  "merchantId",
  "recipient",
  "grossAmount",
  "netAmount",
  "redeemedPoints",
  "earnedUnits",
  "debtRepaid",
  "earnedExpiresAt",
  "campaignVersion",
  "earnBps",
  "maxEarnPoints",
  "createdAt",
  "refunded",
];
const units = (value: string) => ethers.parseEther(value);

describe("Canonical API loyalty reader and receipt validation on actual local contracts", () => {
  it("reads fractional accrual, exact net redemption and merchant-funded refund at their canonical blocks", async () => {
    const [admin, payer, recipient] = await ethers.getSigners();
    const token = await ethers.deployContract("MatsuriStablecoin", [
      "Matsuri Yen",
      "MJPY",
      admin.address,
    ]);
    const points = await ethers.deployContract("LoyaltyPoints", [
      await token.getAddress(),
      admin.address,
    ]);
    const uuid = randomUUID(),
      merchant = ethers.id(uuid);
    await points.setMerchant(merchant, recipient.address, true);
    await points.setCampaign(merchant, true, units("1"), 500, 50, 30 * 86400);
    await token.mint(payer.address, units("100"));
    await token.connect(payer).approve(await points.getAddress(), units("100"));
    const deadline =
      (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
    const first = await (
      await points
        .connect(payer)
        .pay(ethers.id("reader17"), merchant, units("17"), deadline)
    ).wait();
    expect(first!.blockNumber).lessThan(16);
    const reader = new CanonicalRewardReader(
      (method, args) => ethers.provider.send(method, args),
      "31337",
      await points.getAddress(),
      "loyalty",
    );
    async function anchor(number: number) {
      const block = (await ethers.provider.getBlock(number))!;
      return { number: String(number), hash: block.hash! };
    }
    const firstBlock = await anchor(first!.blockNumber);
    expect(await reader.read("pointUnit", [], firstBlock)).deep.eq([
      units("1").toString(),
    ]);
    expect(
      (
        await reader.read(
          "pointsBalance",
          [payer.address, merchant],
          firstBlock,
        )
      ).slice(0, 3),
    ).deep.eq(["0", units("0.85").toString(), "0"]);
    expect(await reader.read("campaigns", [merchant], firstBlock)).deep.eq([
      true,
      units("1").toString(),
      "500",
      "50",
      "2592000",
      "1",
    ]);
    expect(
      await reader.read(
        "walletMerchantIds",
        [payer.address, "0", "50"],
        firstBlock,
      ),
    ).deep.eq([[merchant], "1"]);
    expect(
      await reader.read("merchantWallets", [merchant, "0", "50"], firstBlock),
    ).deep.eq([[payer.address], "1"]);
    const second = await (
      await points
        .connect(payer)
        .pay(ethers.id("reader3"), merchant, units("3"), deadline)
    ).wait();
    const secondBlock = await anchor(second!.blockNumber);
    expect(
      (
        await reader.read(
          "pointsBalance",
          [payer.address, merchant],
          secondBlock,
        )
      ).slice(0, 3),
    ).deep.eq(["1", "0", "0"]);
    const invoice = ethers.id("readerRedeem");
    const payment = await (
      await points
        .connect(payer)
        .payWithPoints(invoice, merchant, units("2"), deadline, 1)
    ).wait();
    const paidBlock = await anchor(payment!.blockNumber);
    const tuple = await reader.read(
      "payments",
      [payer.address, invoice],
      paidBlock,
    );
    expect(tuple).length(13);
    expect(tuple[3]).eq(units("1").toString());
    expect(tuple[4]).eq("1");
    expect(tuple[5]).eq(units("0.05").toString());
    const state = Object.fromEntries(
      paymentFields.map((key, index) => [key, tuple[index]]),
    );
    const previous = {
      CHAIN_ID: config.CHAIN_ID,
      LOYALTY_PAYMENT_ADDRESS: config.LOYALTY_PAYMENT_ADDRESS,
      TOKEN_ADDRESS: config.TOKEN_ADDRESS,
      TOKEN_DECIMALS: config.TOKEN_DECIMALS,
    };
    // Configure the real deployed local addresses for these pure receipt validators; no provider is replaced.
    Object.assign(config, {
      CHAIN_ID: "31337",
      LOYALTY_PAYMENT_ADDRESS: (await points.getAddress()).toLowerCase(),
      TOKEN_ADDRESS: (await token.getAddress()).toLowerCase(),
      TOKEN_DECIMALS: 18,
    });
    try {
      const job = {
        expected_router: config.LOYALTY_PAYMENT_ADDRESS,
        expected_router_label: "loyaltypoints",
        invoice_id: invoice,
        merchant_id: uuid,
        address: payer.address.toLowerCase(),
        recipient: recipient.address.toLowerCase(),
        amount: units("1").toString(),
        gross_amount: units("2").toString(),
        points_redeemed: "1",
        discount_amount: units("1").toString(),
      };
      const realLogs = payment!.logs.map((log) => ({
        ...log,
        logIndex: String(log.index),
      }));
      const events = validateLoyaltyReceipt(realLogs, job, state);
      expect(events.map((e) => e.kind).sort()).deep.eq(["earned", "redeemed"]);
      expect(() =>
        validateLoyaltyReceipt(
          realLogs,
          { ...job, points_redeemed: "2" },
          state,
        ),
      ).to.throw();
      await token
        .connect(recipient)
        .approve(await points.getAddress(), units("1"));
      const refund = await (
        await points.connect(recipient).refund(invoice, payer.address)
      ).wait();
      const refundedBlock = await anchor(refund!.blockNumber);
      const refundedTuple = await reader.read(
        "payments",
        [payer.address, invoice],
        refundedBlock,
      );
      const refundedState = Object.fromEntries(
        paymentFields.map((key, index) => [key, refundedTuple[index]]),
      );
      const row = {
        router_address: config.LOYALTY_PAYMENT_ADDRESS,
        token_address: config.TOKEN_ADDRESS,
        invoice_id: invoice,
        merchant_id: uuid,
        payer: payer.address.toLowerCase(),
        recipient: recipient.address.toLowerCase(),
        amount: units("1").toString(),
      };
      const confirmed = {
        timestamp: (await ethers.provider.getBlock(refund!.blockNumber))!
          .timestamp,
      };
      expect(
        refundReceiptMatches(refund!.logs, row, refundedState, confirmed),
      ).eq(true);
      expect(
        refundReceiptMatches(
          refund!.logs,
          { ...row, payer: recipient.address.toLowerCase() },
          refundedState,
          confirmed,
        ),
      ).eq(false);
      expect(
        (
          await reader.read(
            "pointsBalance",
            [payer.address, merchant],
            refundedBlock,
          )
        ).slice(0, 3),
      ).deep.eq(["1", "0", "0"]);
      const summary = await reader.read(
        "pointsSummary",
        [payer.address, merchant],
        refundedBlock,
      );
      expect(summary).deep.eq([
        units("1.05").toString(),
        "1",
        "0",
        units("1").toString(),
        units("0.05").toString(),
        "0",
        units("1").toString(),
      ]);
      expect(await token.balanceOf(recipient.address)).eq(units("20"));
      // Refunds cannot rewrite the earlier canonical snapshot or its fractional progress.
      expect(
        (
          await reader.read(
            "pointsBalance",
            [payer.address, merchant],
            firstBlock,
          )
        )[1],
      ).eq(units("0.85").toString());
      expect(
        (
          await reader.read("payments", [payer.address, invoice], paidBlock)
        )[12],
      ).eq(false);
      expect(refundedTuple[12]).eq(true);
    } finally {
      Object.assign(config, previous);
    }
  });
  it("does not confuse refund event debt with debt changed by a later transaction in the same block", async () => {
    const [owner, payer, recipient] = await ethers.getSigners();
    const token = await ethers.deployContract("MatsuriStablecoin", [
      "Matsuri Yen",
      "MJPY",
      owner.address,
    ]);
    const points = await ethers.deployContract("LoyaltyPoints", [
      await token.getAddress(),
      owner.address,
    ]);
    const uuid = randomUUID(),
      merchant = ethers.id(uuid),
      invoice = ethers.id("same-block-refund");
    await points.setMerchant(merchant, recipient.address, true);
    await points.setCampaign(merchant, true, units("1"), 500, 50, 2592000);
    await token.mint(payer.address, units("1000"));
    await token
      .connect(payer)
      .approve(await points.getAddress(), units("1000"));
    await token
      .connect(recipient)
      .approve(await points.getAddress(), units("1000"));
    const deadline =
      (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
    await points.connect(payer).pay(invoice, merchant, units("100"), deadline);
    await points
      .connect(payer)
      .payWithPoints(
        ethers.id("used-before-refund"),
        merchant,
        units("5"),
        deadline,
        5,
      );
    let refund: any, next: any;
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      const fees = {
        gasLimit: 1000000,
        gasPrice: ethers.parseUnits("2", "gwei"),
      };
      refund = await points
        .connect(recipient)
        .refund(invoice, payer.address, fees);
      next = await points
        .connect(payer)
        .pay(
          ethers.id("after-refund-same-block"),
          merchant,
          units("100"),
          deadline,
          fees,
        );
      await ethers.provider.send("evm_mine", []);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
    const refunded = (await refund.wait())!,
      paid = (await next.wait())!;
    expect(refunded.blockNumber).eq(paid.blockNumber);
    expect(refunded.index).lessThan(paid.index);
    const emitted = refunded.logs
      .map((log: any) => {
        try {
          return points.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((event: any) => event?.name === "PaymentRefunded")!;
    expect(emitted.args.debtUnits).eq(units("5"));
    expect((await points.pointsBalance(payer.address, merchant)).debtUnits).eq(
      0,
    );
    const reader = new CanonicalRewardReader(
      (method, args) => ethers.provider.send(method, args),
      "31337",
      await points.getAddress(),
      "loyalty",
    );
    const block = (await ethers.provider.getBlock(refunded.blockNumber))!;
    const tuple = await reader.read("payments", [payer.address, invoice], {
      number: String(block.number),
      hash: block.hash!,
    });
    const state = Object.fromEntries(
      paymentFields.map((key, index) => [key, tuple[index]]),
    );
    const previous = {
      LOYALTY_PAYMENT_ADDRESS: config.LOYALTY_PAYMENT_ADDRESS,
      TOKEN_DECIMALS: config.TOKEN_DECIMALS,
    };
    Object.assign(config, {
      LOYALTY_PAYMENT_ADDRESS: (await points.getAddress()).toLowerCase(),
      TOKEN_DECIMALS: 18,
    });
    try {
      const row = {
        router_address: (await points.getAddress()).toLowerCase(),
        token_address: (await token.getAddress()).toLowerCase(),
        invoice_id: invoice,
        merchant_id: uuid,
        payer: payer.address.toLowerCase(),
        recipient: recipient.address.toLowerCase(),
        amount: units("100").toString(),
      };
      expect(
        refundReceiptMatches(refunded.logs, row, state, {
          timestamp: block.timestamp,
        }),
      ).eq(true);
    } finally {
      Object.assign(config, previous);
    }
  });
});
