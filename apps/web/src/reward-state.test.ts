import { test } from "node:test";
import assert from "node:assert/strict";
import type { Reward } from "./api";
import { rewardActivity, rewardStatus } from "./reward-state";

const reward: Reward = {
  id: "1",
  cardId: "card",
  walletAddress: "0x1",
  merchantId: "shop",
  merchantName: "Shop",
  discountBps: 5000,
  maxDiscount: "50000000000000000000",
  minPurchase: "100000000000000000000",
  expiresAt: "2026-10-01T00:00:00Z",
  status: "available",
  earnedAt: "2026-09-26T00:00:00Z",
  earnedTxHash: "earned",
  earnedExplorerUrl: null,
  redeemedAt: null,
  redeemedTxHash: null,
  redeemedExplorerUrl: null,
};
test("expiry never turns an in-flight or used reward back into available", () => {
  const now = Date.parse("2026-10-02T00:00:00Z");
  assert.equal(rewardStatus(reward, now), "expired");
  assert.equal(
    rewardStatus({ ...reward, status: "reserved" }, now),
    "reserved",
  );
  assert.equal(rewardStatus({ ...reward, status: "used" }, now), "used");
});
test("activity requires actual receipt references and keeps earned and redeemed events distinct", () => {
  assert.deepEqual(rewardActivity([{ ...reward, earnedTxHash: null }]), []);
  const used = {
    ...reward,
    status: "used" as const,
    redeemedAt: "2026-09-27T00:00:00Z",
    redeemedTxHash: "redeemed",
  };
  assert.deepEqual(
    rewardActivity([used]).map((entry) => entry.label),
    ["Reward redeemed", "Reward earned"],
  );
  assert.deepEqual(
    rewardActivity([{ ...used, status: "reserved" }]).map(
      (entry) => entry.label,
    ),
    ["Reward earned"],
  );
});

test("credit collectibles retain identity and every confirmed partial redemption", async () => {
  const { collectibleKey, rewardCredit } = await import("./reward-state");
  const item: Reward = {
    ...reward,
    rewardType: "credit",
    collectionKey: "0xnew:1",
    tokenId: "1",
    contractAddress: "0xnew",
    nftOwned: true,
    creditAmount: "500",
    remainingCredit: "300",
    events: [
      {
        id: "mint:0",
        kind: "earned",
        createdAt: "2026-09-26T00:00:00Z",
        txHash: "mint",
        explorerUrl: null,
      },
      {
        id: "partial:0",
        kind: "redeemed",
        createdAt: "2026-09-26T00:01:00Z",
        txHash: "partial",
        explorerUrl: null,
        discountAmount: "200",
        remainingCredit: "300",
      },
    ],
  };
  assert.notEqual(
    collectibleKey(item),
    collectibleKey({ ...item, collectionKey: "0xold:1" }),
  );
  assert.equal(rewardCredit(item), "300");
  assert.equal(rewardActivity([item]).length, 2);
  const used = { ...item, status: "used" as const, remainingCredit: "0" };
  assert.equal(rewardCredit(used), "0");
  assert.equal(rewardStatus(used, Date.parse("2030-01-01")), "used");
  assert.equal(rewardActivity([{ ...item, events: [] }]).length, 0);
});
test("collectible artwork is restricted to the deployed content-addressed public assets", async () => {
  const { collectibleImage } = await import("./reward-state");
  const url =
    "https://main.d21bivg674x6ke.amplifyapp.com/nft-art/07da091cde725ea51a19/1.jpg";
  assert.equal(collectibleImage(url), url);
  for (const bad of [
    "javascript:alert(1)",
    "https://evil.test/nft-art/07da091cde725ea51a19/1.jpg",
    url + "?token=secret",
    url.replace("/1.jpg", "/../../private"),
  ])
    assert.equal(collectibleImage(bad), null);
});
