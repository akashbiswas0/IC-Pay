import { expect } from "chai";
import { network } from "hardhat";
import { readFile } from "node:fs/promises";
const { ethers } = await network.create();
const merchant = ethers.id("collectible-shop");
const other = ethers.id("collectible-other-shop");
const art = "https://main.d21bivg674x6ke.amplifyapp.com/nft-art/contenthash/";
const units = (value: string) => ethers.parseEther(value);
const invoice = (value: string) => ethers.id(value);
async function fixture() {
  const [admin, alice, recipient, bob] = await ethers.getSigners();
  const token = await ethers.deployContract("MatsuriStablecoin", [
    "Matsuri Yen",
    "MJPY",
    admin.address,
  ]);
  const rewards = await ethers.deployContract("CollectibleRewards", [
    await token.getAddress(),
    admin.address,
    art,
  ]);
  await rewards.setMerchant(merchant, recipient.address, true);
  await rewards.setMerchant(other, recipient.address, true);
  await rewards.setCampaign(
    merchant,
    true,
    units("1"),
    500,
    units("50"),
    2592000,
  );
  for (const user of [alice, bob]) {
    await token.mint(user.address, units("5000"));
    await token
      .connect(user)
      .approve(await rewards.getAddress(), units("5000"));
  }
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
  return { admin, alice, bob, recipient, token, rewards, deadline };
}
async function earn(f: Awaited<ReturnType<typeof fixture>>, amount = "100") {
  await f.rewards
    .connect(f.alice)
    .pay(invoice("earn"), merchant, units(amount), f.deadline);
}
async function metadata(rewards: any, id = 1) {
  const uri = await rewards.tokenURI(id);
  return JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
}
describe("CollectibleRewards permanent NFTs and purchase-earned credit", () => {
  it("earns different credit for real purchase amounts and caps issuance", async () => {
    const f = await fixture();
    for (const [index, amount, credit] of [
      [1, "100", "5"],
      [2, "200", "10"],
      [3, "2000", "50"],
    ] as const) {
      const tx = await f.rewards
        .connect(f.alice)
        .pay(invoice(`earn-${index}`), merchant, units(amount), f.deadline);
      const block = await ethers.provider.getBlock(
        (await tx.wait())!.blockNumber,
      );
      await expect(tx)
        .to.emit(f.rewards, "CreditIssued")
        .withArgs(
          index,
          f.alice.address,
          merchant,
          invoice(`earn-${index}`),
          1,
          units(amount),
          units(credit),
          500,
          units("50"),
          block!.timestamp + 2592000,
        );
      const voucher = await f.rewards.vouchers(index);
      expect(voucher.purchaseAmount).eq(units(amount));
      expect(voucher.creditAmount).eq(units(credit));
      expect(voucher.remainingCredit).eq(units(credit));
      expect(await f.rewards.ownerOf(index)).eq(f.alice.address);
    }
    expect(await f.token.balanceOf(f.recipient.address)).eq(units("2300"));
  });
  it("carries partial credit then fully covers a payment without allowance or burning", async () => {
    const f = await fixture();
    await earn(f);
    await f.token.connect(f.alice).approve(await f.rewards.getAddress(), 0);
    expect(
      await f.rewards.quoteReward(1, f.alice.address, merchant, units("2")),
    ).deep.eq([units("2"), 0n]);
    const partial = await f.rewards
      .connect(f.alice)
      .payWithReward(invoice("partial"), merchant, units("2"), f.deadline, 1);
    await expect(partial)
      .to.emit(f.rewards, "CreditRedeemed")
      .withArgs(
        1,
        f.alice.address,
        merchant,
        invoice("partial"),
        units("2"),
        units("2"),
        0,
        units("3"),
      );
    expect((await f.rewards.vouchers(1)).redeemed).eq(false);
    const full = await f.rewards
      .connect(f.alice)
      .payWithReward(invoice("full"), merchant, units("3"), f.deadline, 1);
    await expect(full)
      .to.emit(f.rewards, "PaymentCompleted")
      .withArgs(
        invoice("full"),
        merchant,
        f.alice.address,
        f.recipient.address,
        await f.token.getAddress(),
        0,
      );
    await expect(full).to.emit(f.rewards, "MetadataUpdate").withArgs(1);
    const receipt = (await full.wait())!;
    expect(receipt.logs.filter((log) => log.address === f.token.target)).length(
      0,
    );
    expect(
      receipt.logs.filter(
        (log) =>
          log.topics[0] ===
          f.rewards.interface.getEvent("CreditIssued")!.topicHash,
      ),
    ).length(0);
    expect(await f.rewards.ownerOf(1)).eq(f.alice.address);
    expect(await f.rewards.balanceOf(f.alice.address)).eq(1);
    expect(await f.rewards.nextVoucherId()).eq(2);
    const used = await f.rewards.vouchers(1);
    expect(used.remainingCredit).eq(0);
    expect(used.redeemed).eq(true);
    expect(used.redeemedInvoiceId).eq(invoice("full"));
    expect(used.redeemedAt).greaterThan(0n);
    await expect(
      f.rewards
        .connect(f.alice)
        .payWithReward(invoice("again"), merchant, 1, f.deadline, 1),
    ).revertedWithCustomError(f.rewards, "VoucherUnavailable");
  });
  it("charges only net credit shortfall and earns no recursive reward", async () => {
    const f = await fixture();
    await earn(f);
    const before = await f.token.balanceOf(f.recipient.address);
    await f.rewards
      .connect(f.alice)
      .payWithReward(invoice("net"), merchant, units("20"), f.deadline, 1);
    expect(await f.token.balanceOf(f.recipient.address)).eq(
      before + units("15"),
    );
    expect(await f.rewards.nextVoucherId()).eq(2);
  });
  it("restores credit, permanent ownership and invoice state when allowance or balance fails", async () => {
    const f = await fixture();
    await earn(f);
    await f.token.connect(f.alice).approve(await f.rewards.getAddress(), 0);
    await expect(
      f.rewards
        .connect(f.alice)
        .payWithReward(
          invoice("rollback"),
          merchant,
          units("20"),
          f.deadline,
          1,
        ),
    ).revert(ethers);
    expect((await f.rewards.vouchers(1)).remainingCredit).eq(units("5"));
    expect(await f.rewards.settled(f.alice.address, invoice("rollback"))).eq(
      false,
    );
    await f.token
      .connect(f.alice)
      .approve(await f.rewards.getAddress(), units("20"));
    await f.token
      .connect(f.alice)
      .transfer(f.bob.address, await f.token.balanceOf(f.alice.address));
    await expect(
      f.rewards
        .connect(f.alice)
        .payWithReward(
          invoice("rollback"),
          merchant,
          units("20"),
          f.deadline,
          1,
        ),
    ).revert(ethers);
    expect((await f.rewards.vouchers(1)).redeemed).eq(false);
    expect(await f.rewards.ownerOf(1)).eq(f.alice.address);
    await f.token.mint(f.alice.address, units("15"));
    await f.rewards
      .connect(f.alice)
      .payWithReward(invoice("rollback"), merchant, units("20"), f.deadline, 1);
    expect((await f.rewards.vouchers(1)).redeemed).eq(true);
  });
  it("binds credits to holder/merchant and blocks replay and all NFT transfers", async () => {
    const f = await fixture();
    await earn(f);
    await expect(
      f.rewards
        .connect(f.bob)
        .payWithReward(invoice("other"), merchant, 1, f.deadline, 1),
    ).revertedWithCustomError(f.rewards, "WrongVoucherHolder");
    await expect(
      f.rewards
        .connect(f.alice)
        .payWithReward(invoice("other"), other, 1, f.deadline, 1),
    ).revertedWithCustomError(f.rewards, "WrongVoucherMerchant");
    await expect(
      f.rewards.connect(f.alice).pay(invoice("earn"), merchant, 1, f.deadline),
    ).revertedWithCustomError(f.rewards, "InvoiceAlreadySettled");
    await f.rewards
      .connect(f.bob)
      .pay(invoice("earn"), merchant, units("1"), f.deadline);
    for (const destination of [f.bob.address, ethers.ZeroAddress])
      await expect(
        f.rewards
          .connect(f.alice)
          .transferFrom(f.alice.address, destination, 1),
      ).revert(ethers);
    await expect(
      f.rewards.connect(f.alice).approve(f.bob.address, 1),
    ).revertedWithCustomError(f.rewards, "NonTransferable");
    await expect(
      f.rewards.connect(f.alice).setApprovalForAll(f.bob.address, true),
    ).revertedWithCustomError(f.rewards, "NonTransferable");
    await f.rewards
      .connect(f.alice)
      .payWithReward(invoice("partial"), merchant, 1, f.deadline, 1);
    const remaining = (await f.rewards.vouchers(1)).remainingCredit;
    await expect(
      f.rewards
        .connect(f.alice)
        .payWithReward(invoice("partial"), merchant, 1, f.deadline, 1),
    ).revertedWithCustomError(f.rewards, "InvoiceAlreadySettled");
    expect((await f.rewards.vouchers(1)).remainingCredit).eq(remaining);
  });
  it("honors issued credit when campaign terms change or pause, but not merchant disable", async () => {
    const f = await fixture();
    await earn(f);
    await f.rewards.setCampaign(
      merchant,
      false,
      units("500"),
      100,
      units("1"),
      60,
    );
    const v = await f.rewards.vouchers(1);
    expect(v.earnBps).eq(500);
    expect(v.campaignVersion).eq(1);
    expect(v.creditAmount).eq(units("5"));
    expect(
      await f.rewards.quoteReward(1, f.alice.address, merchant, units("2")),
    ).deep.eq([units("2"), 0n]);
    await f.rewards
      .connect(f.alice)
      .pay(invoice("paused"), merchant, units("100"), f.deadline);
    expect(await f.rewards.nextVoucherId()).eq(2);
    await f.rewards.setMerchant(merchant, f.recipient.address, false);
    await expect(
      f.rewards.quoteReward(1, f.alice.address, merchant, 1),
    ).revertedWithCustomError(f.rewards, "MerchantDisabled");
    await expect(
      f.rewards.setMerchant(merchant, f.bob.address, true),
    ).revertedWithCustomError(f.rewards, "MerchantRecipientImmutable");
  });
  it("retains expired NFT ownership and reports live metadata status and fixed artwork", async () => {
    const f = await fixture();
    await earn(f);
    expect(await f.rewards.supportsInterface("0x49064906")).eq(true);
    const m = await metadata(f.rewards);
    expect(m.image).eq(art + "1.jpg");
    expect(
      m.attributes.find((a: any) => a.trait_type === "Earned credit base units")
        .value,
    ).eq(units("5").toString());
    const voucher = await f.rewards.vouchers(1);
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(voucher.expiresAt) + 1,
    ]);
    await ethers.provider.send("evm_mine", []);
    await expect(
      f.rewards.quoteReward(1, f.alice.address, merchant, 1),
    ).revertedWithCustomError(f.rewards, "VoucherExpired");
    expect(await f.rewards.ownerOf(1)).eq(f.alice.address);
    expect(
      (await metadata(f.rewards)).attributes.find(
        (a: any) => a.trait_type === "Status",
      ).value,
    ).eq("expired");
    expect(await f.rewards.issuedVoucherIds(f.alice.address, 0, 50)).deep.eq([
      [1n],
      1n,
    ]);
    expect(await f.rewards.issuedVoucherIds(f.alice.address, 50, 1)).deep.eq([
      [],
      1n,
    ]);
    await expect(
      f.rewards.issuedVoucherIds(f.alice.address, 0, 51),
    ).revertedWithCustomError(f.rewards, "InvalidPageSize");
  });
  it("does not mint rounded-zero credit and validates campaign, invoice and metadata boundaries", async () => {
    const f = await fixture();
    await f.rewards.setCampaign(merchant, true, 1, 1, 100, 60);
    expect(await f.rewards.quotePayment(merchant, 1)).deep.eq([false, 2n]);
    await f.rewards
      .connect(f.alice)
      .pay(invoice("rounded"), merchant, 1, f.deadline);
    expect(await f.rewards.nextVoucherId()).eq(1);
    await expect(
      f.rewards.connect(f.alice).setCampaign(merchant, true, 1, 500, 1, 60),
    ).revert(ethers);
    for (const bps of [0, 10001])
      await expect(
        f.rewards.setCampaign(merchant, true, 1, bps, 1, 60),
      ).revertedWithCustomError(f.rewards, "InvalidCampaign");
    await expect(
      f.rewards.connect(f.alice).pay(invoice("zero"), merchant, 0, f.deadline),
    ).revertedWithCustomError(f.rewards, "InvalidAmount");
    await expect(
      f.rewards.connect(f.alice).pay(invoice("late"), merchant, 1, 1),
    ).revertedWithCustomError(f.rewards, "InvoiceExpired");
    for (const uri of [
      "http://example.com/",
      'https://example.com/"',
      "https://example.com/\\/",
      "https://user@example.com/",
      "https:///",
    ])
      await expect(
        ethers.deployContract("CollectibleRewards", [
          await f.token.getAddress(),
          f.admin.address,
          uri,
        ]),
      ).revert(ethers);
  });
  it("keeps existing RewardPayments bytecode unchanged and new deployment below EIP-170", async () => {
    const old = JSON.parse(
      await readFile(
        new URL(
          "../artifacts/src/RewardPayments.sol/RewardPayments.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(ethers.keccak256(old.bytecode)).eq(
      "0xc708a64b364a38c4574c099e31461bf92f988043afad4ea9acb8daac3bfe7118",
    );
    const current = JSON.parse(
      await readFile(
        new URL(
          "../artifacts/src/CollectibleRewards.sol/CollectibleRewards.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect((current.deployedBytecode.length - 2) / 2).lessThan(24576);
  });
});
