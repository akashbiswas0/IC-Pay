import { Interface } from "ethers";
import { readRewardAtBlock } from "./reward-read.js";
import { config, hasRewards, hasCollectibles, hasLoyalty } from "./config.js";
import { pool } from "./db.js";
import { AppError } from "./errors.js";
import { merchantBytes32, multibaas } from "./multibaas.js";
import { routerSnapshot } from "./payment-router.js";
import { reconcileOperator, submitOperator } from "./operator.js";
import { confirmedRewardBlock, tuple } from "./rewards.js";
const campaignEvents = new Interface([
  "event CampaignUpdated(bytes32 indexed merchantId,uint64 indexed version,bool enabled,uint256 minPurchase,uint16 discountBps,uint256 maxDiscount,uint64 validitySeconds)",
]);
export function campaignReceiptMatches(logs: any[], operation: any): boolean {
  return logs.some((log) => {
    if (
      log.removed ||
      String(log.address).toLowerCase() !== operation.router_address
    )
      return false;
    try {
      const event = campaignEvents.parseLog(log);
      return (
        event &&
        event.args.merchantId === merchantBytes32(operation.merchant_id) &&
        event.args.enabled === operation.terms.enabled &&
        String(event.args.minPurchase) === operation.terms.minPurchase &&
        Number(event.args.discountBps) ===
          (operation.terms.earnBps ?? operation.terms.discountBps) &&
        String(event.args.maxDiscount) ===
          (operation.terms.maxPointsPerPurchase ??
            operation.terms.maxCredit ??
            operation.terms.maxDiscount) &&
        Number(event.args.validitySeconds) ===
          operation.terms.validitySeconds &&
        BigInt(event.args.version) > 0n
      );
    } catch {
      return false;
    }
  });
}
// Runs under the worker's global advisory lock. An attempted operation without its
// durable signing audit is held for operator recovery, never automatically re-signed.
export async function processRewardCampaigns(
  shouldStop: () => boolean = () => false,
) {
  if (
    (!hasRewards && !hasCollectibles && !hasLoyalty) ||
    !config.AWS_KMS_OPERATOR_KEY_ID
  )
    return;
  const rows = (
    await pool.query(
      "SELECT c.*,m.recipient,m.enabled merchant_enabled FROM reward_campaign_operations c JOIN merchants m ON m.id=c.merchant_id WHERE stage IN ('registration','campaign') ORDER BY created_at LIMIT 2",
    )
  ).rows;
  for (const row of rows) {
    if (shouldStop()) break;
    try {
      routerSnapshot(row.router_address, row.router_label);
      if (
        row.chain_id !== config.CHAIN_ID ||
        row.token_address !== config.TOKEN_ADDRESS ||
        !row.merchant_enabled
      )
        throw new AppError(
          "campaign_unavailable",
          "Reward campaign setup is unavailable.",
          409,
        );
      let stage = row.stage;
      if (stage === "registration") {
        const block = await confirmedRewardBlock();
        const state = await readRewardAtBlock(
          row.router_address,
          row.router_label,
          "merchants",
          [merchantBytes32(row.merchant_id)],
          block,
        );
        const [recipient, enabled] = tuple(state.output, [
          "recipient",
          "enabled",
        ]);
        if (
          String(recipient).toLowerCase() !== "0x" + "00".repeat(20) &&
          !(
            String(recipient).toLowerCase() === row.recipient &&
            enabled === true
          )
        )
          throw new AppError(
            "merchant_disabled",
            "This reward merchant was disabled or its recipient differs. Administrator action is required.",
            409,
          );
        if (
          String(recipient).toLowerCase() === row.recipient &&
          enabled === true
        ) {
          await pool.query(
            "UPDATE reward_campaign_operations SET stage='campaign',error_code=NULL WHERE id=$1",
            [row.id],
          );
          stage = "campaign";
        }
      }
      const id =
        stage === "registration"
          ? row.register_operation_id
          : row.campaign_operation_id;
      const previous = (
        await pool.query("SELECT id FROM operator_transactions WHERE id=$1", [
          id,
        ])
      ).rows[0];
      const attempted =
        stage === "registration"
          ? row.register_attempted_at
          : row.campaign_attempted_at;
      if (!previous && attempted)
        throw new AppError(
          "campaign_submission_unknown",
          "This operation requires reconciliation before another signature.",
          409,
        );
      let operation;
      if (previous) operation = await reconcileOperator(id);
      else {
        const column =
          stage === "registration"
            ? "register_attempted_at"
            : "campaign_attempted_at";
        operation = await submitOperator(
          config.AWS_KMS_OPERATOR_KEY_ID,
          row.router_address,
          row.router_label,
          stage === "registration" ? "setMerchant" : "setCampaign",
          stage === "registration"
            ? [merchantBytes32(row.merchant_id), row.recipient, true]
            : [
                merchantBytes32(row.merchant_id),
                row.terms.enabled,
                row.terms.minPurchase,
                row.terms.earnBps ?? row.terms.discountBps,
                row.terms.maxPointsPerPurchase ??
                  row.terms.maxCredit ??
                  row.terms.maxDiscount,
                row.terms.validitySeconds,
              ],
          id,
          async () => {
            await pool.query(
              `UPDATE reward_campaign_operations SET ${column}=now(),updated_at=now() WHERE id=$1`,
              [row.id],
            );
          },
        );
      }
      if (operation.status === "failed") {
        await pool.query(
          "UPDATE reward_campaign_operations SET stage='failed',error_code='campaign_transaction_reverted',updated_at=now() WHERE id=$1",
          [row.id],
        );
        continue;
      }
      if (operation.status === "confirmed") {
        if (stage === "registration") {
          await pool.query(
            "UPDATE reward_campaign_operations SET stage='campaign',error_code=NULL,updated_at=now() WHERE id=$1",
            [row.id],
          );
          continue;
        }
        const receipt = (await multibaas.receipt(operation.txHash)).data;
        if (!campaignReceiptMatches(receipt.logs, row))
          throw new AppError(
            "campaign_receipt_mismatch",
            "Campaign receipt does not match the requested settings.",
            502,
          );
        await pool.query(
          "UPDATE reward_campaign_operations SET stage='confirmed',error_code=NULL,updated_at=now() WHERE id=$1",
          [row.id],
        );
      }
    } catch (error) {
      await pool.query(
        "UPDATE reward_campaign_operations SET error_code=$2,updated_at=now() WHERE id=$1",
        [
          row.id,
          error instanceof AppError
            ? error.code
            : "campaign_provider_unavailable",
        ],
      );
    }
  }
}
