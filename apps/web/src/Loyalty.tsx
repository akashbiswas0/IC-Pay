import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { request, type Config, type Connection } from "./api";
import { formatAmount, safeExternalUrl } from "./money";
import {
  formatPoints,
  pointProgress,
  loyaltyEventLabel,
  type LoyaltyResponse,
  type LoyaltyProgramResponse,
} from "./loyalty-state";

type Props = {
  connection: Connection;
  config: Config;
  cardId?: string;
  hasWallet: boolean;
  merchant?: boolean;
  compact?: boolean;
  history?: boolean;
  revision?: number;
};
const date = (value: string) =>
  Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Date unavailable";

export default function Loyalty({
  connection,
  config,
  cardId,
  hasWallet,
  merchant = false,
  compact = false,
  history = false,
  revision = 0,
}: Props) {
  const [data, setData] = useState<LoyaltyResponse | null>(null);
  const [business, setBusiness] = useState<LoyaltyProgramResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const reload = useRef<() => void>(() => {});
  const enabled = config.capabilities.loyalty === true;
  useEffect(() => {
    reload.current = () => {};
    setData(null);
    setBusiness(null);
    setError("");
    if (!enabled || (!merchant && !hasWallet)) {
      setLoading(false);
      return;
    }
    let disposed = false;
    let controller: AbortController | null = null;
    const path = merchant
      ? "/v1/merchant/loyalty/program"
      : `/v1/loyalty${cardId ? `?cardId=${encodeURIComponent(cardId)}` : ""}`;
    const load = () => {
      // Background revisions coalesce; only a different wallet/session cancels a read.
      if (disposed || controller) return;
      const current = new AbortController();
      controller = current;
      setLoading(true);
      setError("");
      request<LoyaltyResponse | LoyaltyProgramResponse>(connection, path, {
        signal: current.signal,
      })
        .then((value) => {
          if (current.signal.aborted) return;
          if ("balances" in value) setData(value);
          else setBusiness(value);
        })
        .catch((cause) => {
          if (!current.signal.aborted)
            setError(
              cause instanceof Error
                ? cause.message
                : "Points could not be loaded.",
            );
        })
        .finally(() => {
          if (!current.signal.aborted) setLoading(false);
          if (controller === current) controller = null;
        });
    };
    reload.current = load;
    load();
    return () => {
      disposed = true;
      controller?.abort();
    };
  }, [connection, enabled, merchant, hasWallet, cardId]);
  useEffect(() => {
    reload.current();
  }, [revision, refresh]);
  if (!enabled) return null;
  const status = merchant ? business?.status : data?.status;
  const items = compact ? data?.balances?.slice(0, 3) : data?.balances;
  const program = business?.program;
  const operation = business?.operation;
  return (
    <section
      className="loyalty-section"
      aria-label={merchant ? "Merchant loyalty program" : "Loyalty points"}
    >
      <div className="section-heading">
        <h2>
          {history
            ? "Points activity"
            : merchant
              ? "Your points program"
              : "Loyalty points"}
        </h2>
        <button
          className="quiet"
          disabled={loading || (!merchant && !hasWallet)}
          onClick={() => setRefresh((v) => v + 1)}
          aria-label="Refresh loyalty points"
        >
          <RefreshCw size={16} className={loading ? "spinning" : ""} />
          {loading ? "Refreshing" : "Refresh"}
        </button>
      </div>
      {!merchant && !hasWallet ? (
        <p className="notice">
          Finish setting up a card wallet to earn points at participating shops.
        </p>
      ) : error ? (
        <p className="notice error" role="alert">
          {error} Refresh to try again.
        </p>
      ) : loading && !data && !business ? (
        <div className="loyalty-loading" role="status">
          <span className="sr-only">Loading confirmed points…</span>
          <span />
          <span />
        </div>
      ) : status === "pending_setup" ? (
        <p className="notice">
          Points are being set up. Your existing vouchers remain available.
        </p>
      ) : status !== "available" ? (
        <p className="notice" role="status">
          Points are temporarily unavailable. Refresh to check again.
        </p>
      ) : merchant ? (
        <>
          {program ? (
            <div className="loyalty-program">
              <span className="status">
                {program.enabled ? "Earning enabled" : "Earning paused"}
              </span>
              <h3>{program.earnBps / 100}% back in points</h3>
              <p>
                Earn on the amount paid, up to{" "}
                {formatPoints(program.maxPointsPerPurchase)} points per
                purchase. Minimum purchase:{" "}
                {formatAmount(program.minPurchase, config.token.decimals)}{" "}
                {config.token.symbol}.
              </p>
              <p className="field-hint">
                One program for all your customers. Points expire at the next
                UTC day boundary after {program.validitySeconds / 86400} days.
                Existing points keep their expiry.
              </p>
            </div>
          ) : (
            <p className="notice">
              Enable your points program in the merchant iPhone app. Set it up
              once for all customers.
            </p>
          )}
          {operation && !["confirmed", "failed"].includes(operation.status) && (
            <p className="notice" role="status">
              Your program update is awaiting confirmation. The terms above are
              the currently confirmed program.
            </p>
          )}
          {operation?.status === "failed" && (
            <p className="notice error">
              The program update failed. Review and retry it in the merchant
              iPhone app.
            </p>
          )}
          {business?.summary ? (
            <dl className="loyalty-metrics">
              {(
                [
                  [
                    business.summary.outstandingUnits !== undefined
                      ? "Outstanding reward value"
                      : "Outstanding whole points",
                    business.summary.outstandingUnits !== undefined
                      ? `${formatAmount(business.summary.outstandingUnits, config.token.decimals)} ${config.token.symbol}`
                      : formatPoints(business.summary.outstandingPoints),
                  ],
                  [
                    "Points earned",
                    business.summary.earnedUnits !== undefined
                      ? formatAmount(
                          business.summary.earnedUnits,
                          config.token.decimals,
                        )
                      : formatPoints(business.summary.earnedPoints),
                  ],
                  [
                    "Points used",
                    formatPoints(business.summary.redeemedPoints),
                  ],
                  [
                    "Points restored",
                    business.summary.refundedUnits !== undefined
                      ? formatAmount(
                          business.summary.refundedUnits,
                          config.token.decimals,
                        )
                      : formatPoints(business.summary.refundedPoints),
                  ],
                  ...(business.summary.expiredPoints !== undefined
                    ? [
                        [
                          "Points expired",
                          business.summary.expiredUnits !== undefined
                            ? formatAmount(
                                business.summary.expiredUnits,
                                config.token.decimals,
                              )
                            : formatPoints(business.summary.expiredPoints),
                        ],
                      ]
                    : []),
                  ...(business.summary.reversedPoints !== undefined
                    ? [
                        [
                          "Earnings reversed",
                          business.summary.reversedUnits !== undefined
                            ? formatAmount(
                                business.summary.reversedUnits,
                                config.token.decimals,
                              )
                            : formatPoints(business.summary.reversedPoints),
                        ],
                      ]
                    : []),
                ] as [string, string][]
              ).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
              <div>
                <dt>Customer wallets</dt>
                <dd>{business.summary.customerWallets.toLocaleString()}</dd>
              </div>
            </dl>
          ) : (
            <p className="notice">
              Points totals are unavailable. Refresh to try again.
            </p>
          )}
          <p className="field-hint">
            One point covers 1 {config.token.symbol} at your shop. Manage your
            program in the iPhone app.
          </p>
        </>
      ) : history ? (
        data?.history === null ? (
          <p className="notice">Points history is unavailable.</p>
        ) : data?.history?.length ? (
          <div className="loyalty-history">
            {data.history.map((event) => {
              const url = safeExternalUrl(event.explorerUrl);
              return (
                <article key={event.id}>
                  <div>
                    <h3>{loyaltyEventLabel(event.kind)}</h3>
                    <p>{event.merchantName}</p>
                    {event.debtRepaidUnits && event.debtRepaidUnits !== "0" && (
                      <p className="field-hint">
                        {formatAmount(
                          event.debtRepaidUnits,
                          config.token.decimals,
                        )}{" "}
                        points offset earlier refunded earnings.
                      </p>
                    )}
                    <time dateTime={event.createdAt}>
                      {date(event.createdAt)}
                    </time>
                  </div>
                  <strong>
                    {event.pointsUnits !== undefined
                      ? formatAmount(event.pointsUnits, config.token.decimals)
                      : formatPoints(event.points)}{" "}
                    pts
                  </strong>
                  {url && (
                    <a
                      className="icon-button"
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`View ${loyaltyEventLabel(event.kind).toLowerCase()} transaction`}
                    >
                      <ExternalLink size={18} />
                    </a>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <p className="notice">
            Confirmed points earnings and redemptions will appear here.
          </p>
        )
      ) : items === null ? (
        <p className="notice">Points balances are unavailable.</p>
      ) : !items?.length ? (
        <div className="wallet-empty">
          <h3>Your first purchase starts your balance</h3>
          <p>
            Pay at a shop with points enabled. Earnings appear after payment
            confirms.
          </p>
        </div>
      ) : (
        <>
          <div className="loyalty-balances">
            {items.map((balance) => {
              const progress = pointProgress(
                balance.fractionNumerator,
                balance.fractionDenominator,
              );
              return (
                <article key={balance.id}>
                  <div className="section-heading">
                    <h3>{balance.merchantName}</h3>
                    {!balance.merchantEnabled && (
                      <span className="status">Shop unavailable</span>
                    )}
                  </div>
                  <p className="loyalty-total">
                    {formatPoints(balance.spendablePoints)}{" "}
                    <span>points available</span>
                  </p>
                  {balance.reservedPoints !== "0" && (
                    <p className="field-hint">
                      {formatPoints(balance.reservedPoints)} points reserved for
                      a pending payment.
                    </p>
                  )}
                  {progress && progress.percent > 0 && (
                    <div className="loyalty-progress">
                      <progress
                        max={100}
                        value={progress.percent}
                        aria-label={progress.label}
                      />
                      <p className="field-hint">
                        {progress.label}. Small purchases add up.
                      </p>
                    </div>
                  )}
                  {balance.expiresAt && (
                    <p className="field-hint">
                      Next expiry: {date(balance.expiresAt)}. Some or all of
                      your balance expires then.
                    </p>
                  )}
                  {balance.debtUnits && balance.debtUnits !== "0" && (
                    <p className="field-hint">
                      {formatAmount(balance.debtUnits, config.token.decimals)}{" "}
                      points from refunded purchases must be offset before all
                      new earnings become available.
                    </p>
                  )}
                  {!cardId && (
                    <p className="field-hint">
                      Wallet {balance.walletAddress.slice(0, 6)}…
                      {balance.walletAddress.slice(-4)}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
          {compact && (data?.balances?.length ?? 0) > 3 && (
            <p className="field-hint">
              Open Rewards to see all your merchant balances.
            </p>
          )}
          <p className="field-hint">
            Use whole points at the shop that issued them. Fractional progress
            carries forward until expiry. Set automatic use or a limit in
            Spending.
          </p>
        </>
      )}
    </section>
  );
}
