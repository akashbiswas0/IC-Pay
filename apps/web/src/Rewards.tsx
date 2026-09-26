import { useEffect, useState } from "react";
import { ExternalLink, Gift, RefreshCw } from "lucide-react";
import {
  request,
  type Config,
  type Connection,
  type Reward,
  type RewardResponse,
  type CollectiblesResponse,
  type RewardCampaignResponse,
  type CreditCampaignResponse,
} from "./api";
import { formatAmount, safeExternalUrl } from "./money";
import {
  collectibleImage,
  collectibleKey,
  rewardActivity,
  rewardCredit,
  rewardStatus,
} from "./reward-state";

type Props = {
  connection: Connection;
  config: Config;
  cardId?: string;
  hasWallet: boolean;
  revision?: number;
  history?: boolean;
  merchant?: boolean;
  compact?: boolean;
};
const dateLabel = (value: string) =>
  Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Date unavailable";

export function CollectibleCard({
  reward,
  config,
  now = Date.now(),
}: {
  reward: Reward;
  config: Config;
  now?: number;
}) {
  const state = rewardStatus(reward, now),
    credit = rewardCredit(reward),
    image = collectibleImage(reward.imageUrl);
  const isCredit = reward.rewardType === "credit";
  const [artFailed, setArtFailed] = useState(false);
  const unit = (value: string) =>
    `${formatAmount(value, config.token.decimals)} ${config.token.symbol}`;
  const label =
    state === "used"
      ? "Redeemed"
      : state === "reserved"
        ? "Redemption pending"
        : state === "expired"
          ? "Expired"
          : "Available";
  const receipt = safeExternalUrl(
    reward.redeemedExplorerUrl ?? reward.earnedExplorerUrl,
  );
  return (
    <article className="collectible-item">
      {image && (
        <div className="collectible-art">
          <img
            src={image}
            alt={`Japanese print on ${reward.merchantName} collectible #${reward.tokenId ?? reward.id}`}
            loading="lazy"
            decoding="async"
            onError={() => setArtFailed(true)}
            hidden={artFailed}
          />
          {artFailed && (
            <span className="art-unavailable">Artwork unavailable</span>
          )}
        </div>
      )}
      <div className="collectible-copy">
        <div className="section-heading">
          <p>{reward.merchantName}</p>
          <span className={`status reward-status-${state}`}>{label}</span>
        </div>
        <h3>
          {isCredit
            ? state === "used"
              ? reward.creditAmount
                ? `${unit(reward.creditAmount)} earned`
                : "Reward redeemed"
              : credit !== null
                ? `${unit(credit)} credit`
                : "Credit unavailable"
            : reward.discountBps !== null
              ? `${reward.discountBps / 100}% off`
              : "Reward details unavailable"}
        </h3>
        {isCredit ? (
          <p className="field-hint">
            {reward.nftOwned && state === "used"
              ? "Reward used. Your NFT stays in your collection."
              : reward.nftOwned && state === "expired"
                ? "Credit expired. Your NFT stays in your collection."
                : `Use at this shop. ${reward.creditAmount ? unit(reward.creditAmount) : "Amount unavailable"} originally earned.`}
          </p>
        ) : (
          <p className="field-hint">
            Save up to{" "}
            {reward.maxDiscount ? unit(reward.maxDiscount) : "the issued limit"}{" "}
            at this shop.{" "}
            {state === "used"
              ? "This earlier voucher was burned when used."
              : "Earlier voucher terms apply."}
          </p>
        )}
        {state !== "used" && (
          <p className="field-hint">
            {state === "expired" ? "Expired" : "Expires"}{" "}
            {dateLabel(reward.expiresAt)}
          </p>
        )}
        {state === "reserved" && (
          <p className="field-hint">
            The remaining value updates after confirmation.
          </p>
        )}
        <details className="collectible-details">
          <summary>IC Voucher details</summary>
          {reward.purchaseAmount && (
            <p>Earned from a {unit(reward.purchaseAmount)} purchase.</p>
          )}
          {isCredit && (
            <p>
              Smaller purchases use part of the credit. Unused credit remains
              until expiry. Using credit does not earn another reward.
            </p>
          )}
          <p>
            {reward.nftOwned
              ? "Owned, non-transferable NFT"
              : state === "used"
                ? "Redeemed voucher history"
                : "Non-transferable voucher"}{" "}
            · #{reward.tokenId ?? reward.id}
          </p>
          {reward.contractAddress && (
            <p className="collectible-contract">{reward.contractAddress}</p>
          )}
          {receipt && (
            <a
              className="quiet reward-receipt"
              href={receipt}
              target="_blank"
              rel="noopener noreferrer"
            >
              View receipt <ExternalLink size={15} />
            </a>
          )}
        </details>
      </div>
    </article>
  );
}

export default function Rewards({
  connection,
  config,
  cardId,
  hasWallet,
  revision = 0,
  history = false,
  merchant = false,
  compact = false,
}: Props) {
  const [data, setData] = useState<RewardResponse | null>(null);
  const [campaignData, setCampaignData] = useState<
    RewardCampaignResponse | CreditCampaignResponse | null
  >(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0),
    [now, setNow] = useState(Date.now());
  const creditMode = config.capabilities.collectibles === true;
  const ready = creditMode || config.capabilities.rewards === true;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setData(null);
    setCampaignData(null);
    setError("");
    if (!ready || (!merchant && !hasWallet)) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const suffix = cardId ? `?cardId=${encodeURIComponent(cardId)}` : "";
    const task = merchant
      ? request<RewardCampaignResponse | CreditCampaignResponse>(
          connection,
          creditMode
            ? "/v1/merchant/collectibles/campaign"
            : "/v1/merchant/rewards/campaign",
          { signal: controller.signal },
        ).then((result) => {
          if (!controller.signal.aborted) setCampaignData(result);
        })
      : (creditMode
          ? request<CollectiblesResponse>(
              connection,
              `/v1/collectibles${suffix}`,
              { signal: controller.signal },
            ).then((result) => ({
              status: result.status,
              rewards: result.items,
              routerAddress: result.routerAddress,
            }))
          : request<RewardResponse>(connection, `/v1/rewards${suffix}`, {
              signal: controller.signal,
            })
        ).then((result) => {
          if (!controller.signal.aborted) setData(result);
        });
    task
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Couldn’t retrieve collectibles.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    connection,
    ready,
    creditMode,
    cardId,
    hasWallet,
    merchant,
    revision,
    refresh,
  ]);
  const status = merchant ? campaignData?.status : data?.status;
  const campaign = campaignData?.campaign;
  const entries = rewardActivity(data?.rewards ?? []);
  const items = compact
    ? (data?.rewards ?? []).slice(0, 3)
    : (data?.rewards ?? []);
  return (
    <section
      className={`rewards-section${compact ? " collection-preview" : ""}`}
    >
      <div className="section-heading">
        <h2>
          {merchant
            ? config.capabilities.loyalty
              ? "Earlier vouchers"
              : "Your reward offer"
            : history
              ? "Reward activity"
              : "IC Vouchers"}
        </h2>
        <button
          className="quiet"
          disabled={loading || !ready || (!merchant && !hasWallet)}
          onClick={() => setRefresh((v) => v + 1)}
          aria-label="Refresh collectibles"
        >
          <RefreshCw size={16} className={loading ? "spinning" : ""} />
          {loading ? "Refreshing" : "Refresh"}
        </button>
      </div>
      {!ready ? (
        <p className="notice">
          Collectibles aren’t ready yet. Your wallet and payment history remain
          available.
        </p>
      ) : !merchant && !hasWallet ? (
        <p className="notice">
          Collectibles belong to your linked card’s wallet. Finish setting up a
          card in the iPhone app.
        </p>
      ) : error ? (
        <p className="notice error" role="alert">
          {error} Refresh to try again.
        </p>
      ) : loading ? (
        <p className="notice" role="status">
          Loading confirmed collectibles…
        </p>
      ) : status === "pending_setup" ? (
        <p className="notice">
          Reward setup is being completed. Refresh to check again.
        </p>
      ) : status === "unavailable" ? (
        <p className="notice" role="status">
          We couldn’t retrieve the collection. Refresh to try again.
        </p>
      ) : merchant ? (
        <div className="reward-campaign">
          {config.capabilities.loyalty ? (
            <p>
              Existing voucher credit keeps its original terms. Choose an
              earlier voucher at checkout to redeem it. New points payments earn
              points instead of issuing another credit voucher.
            </p>
          ) : (
            <>
              <p className="field-hint">
                One offer for your shop, available to every qualifying customer.
              </p>
              {campaign ? (
                <>
                  <span className="status">
                    {campaign.enabled ? "Earning enabled" : "Earning paused"}
                  </span>
                  <h3>
                    {"earnBps" in campaign
                      ? `${campaign.earnBps / 100}% earned as next-visit credit`
                      : `${campaign.discountBps / 100}% off a later purchase`}
                  </h3>
                  <p>
                    Purchases of at least{" "}
                    {formatAmount(campaign.minPurchase, config.token.decimals)}{" "}
                    {config.token.symbol} earn{" "}
                    {"earnBps" in campaign
                      ? "credit worth up to"
                      : "a reward saving up to"}{" "}
                    {formatAmount(
                      "maxCredit" in campaign
                        ? campaign.maxCredit
                        : campaign.maxDiscount,
                      config.token.decimals,
                    )}{" "}
                    {config.token.symbol}. Valid for{" "}
                    {campaign.validitySeconds / 86400} days.
                  </p>
                  {"earnBps" in campaign && (
                    <p className="field-hint">
                      The reward value depends on the purchase. Unused credit
                      carries forward until expiry, and the NFT remains after
                      use.
                    </p>
                  )}
                  <p className="field-hint">
                    Changes apply to future rewards. Existing rewards keep their
                    earned terms.
                  </p>
                </>
              ) : (
                <>
                  <h3>No offer enabled yet</h3>
                  <p>
                    Enable an offer in the merchant app to start issuing
                    purchase-based rewards.
                  </p>
                </>
              )}
              {campaignData?.operation &&
                !["confirmed", "failed"].includes(
                  campaignData.operation.status,
                ) && (
                  <p className="notice" role="status">
                    Your offer update is awaiting confirmation.
                  </p>
                )}
              {campaignData?.operation?.status === "failed" && (
                <p className="notice error">
                  The offer update failed. Review it in the merchant app.
                </p>
              )}
              <p className="field-hint">Manage this offer in the iPhone app.</p>
            </>
          )}
        </div>
      ) : !data || data.rewards === null ? (
        <p className="notice">
          Collection details are unavailable. Refresh to try again.
        </p>
      ) : history ? (
        entries.length === 0 ? (
          <p className="notice">
            Confirmed rewards and redemptions will appear here.
          </p>
        ) : (
          <div className="reward-list">
            {entries.map((entry) => {
              const url = safeExternalUrl(entry.url);
              return (
                <article className="reward-history-row" key={entry.id}>
                  <Gift size={20} aria-hidden="true" />
                  <div>
                    <h3>
                      {entry.label}
                      {entry.amount
                        ? ` · ${formatAmount(entry.amount, config.token.decimals)} ${config.token.symbol}`
                        : ""}
                    </h3>
                    <p>{entry.merchant}</p>
                    <time dateTime={entry.date}>{dateLabel(entry.date)}</time>
                  </div>
                  {url && (
                    <a
                      className="icon-button"
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`View ${entry.label.toLowerCase()} transaction`}
                    >
                      <ExternalLink size={18} />
                    </a>
                  )}
                </article>
              );
            })}
          </div>
        )
      ) : items.length === 0 ? (
        <div className="wallet-empty">
          <h3>
            {config.capabilities.loyalty
              ? "No earlier collectibles"
              : "Your collection starts with a purchase"}
          </h3>
          <p>
            {config.capabilities.loyalty
              ? "Existing NFT vouchers remain here, including after their credit is used. New points earnings appear in your merchant points balance."
              : "Shop at a merchant with rewards enabled. Once payment confirms, your earned voucher appears here."}
          </p>
        </div>
      ) : (
        <>
          <div className="collectible-grid">
            {items.map((reward) => (
              <CollectibleCard
                key={collectibleKey(reward)}
                reward={reward}
                config={config}
                now={now}
              />
            ))}
          </div>
          {compact && data.rewards.length > 3 && (
            <p className="field-hint">
              Open Rewards to view all {data.rewards.length} collectibles.
            </p>
          )}
          <p className="collection-note">
            Rewards apply at the issuing shop. No cash value. Artwork:
            Katsushika Hokusai, The Met Open Access.
          </p>
        </>
      )}
    </section>
  );
}
