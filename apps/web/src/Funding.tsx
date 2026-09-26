import { useEffect, useState } from "react";
import { ArrowDownLeft, ExternalLink, RefreshCw } from "lucide-react";
import { request, type Connection } from "./api";
import { formatAmount, safeExternalUrl } from "./money";
type Transfer = {
  cardId?: string | null;
  id: string;
  from: string;
  amount: string;
  symbol: string;
  decimals: number;
  createdAt: string;
  txHash: string;
  explorerUrl: string | null;
  status: "confirmed";
};
export default function Funding({
  connection,
  hasWallet,
  cardId,
}: {
  connection: Connection;
  hasWallet: boolean;
  cardId?: string;
}) {
  const [transfers, setTransfers] = useState<Transfer[] | null>(null);
  const [status, setStatus] = useState<
    "available" | "pending_setup" | "unavailable" | null
  >(null);
  const [error, setError] = useState("");
  const [historyComplete, setHistoryComplete] = useState<boolean | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setTransfers(null);
    setStatus(null);
    setError("");
    setHistoryComplete(null);
    if (!hasWallet) return;
    request<{
      transfers: Transfer[] | null;
      status: "available" | "pending_setup" | "unavailable";
      historyComplete?: boolean;
    }>(
      connection,
      cardId
        ? `/v1/cards/${encodeURIComponent(cardId)}/funding`
        : "/v1/funding",
      {
        signal: controller.signal,
      },
    )
      .then((r) => {
        if (controller.signal.aborted) return;
        setTransfers(r.transfers);
        setStatus(r.status);
        setHistoryComplete(r.historyComplete ?? null);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [connection, hasWallet, cardId, revision]);
  return (
    <section className="funding-section">
      <div className="section-heading">
        <h2>{cardId ? "This Suica’s funding" : "Wallet funding"}</h2>
        {hasWallet && (
          <button className="quiet" onClick={() => setRevision((v) => v + 1)}>
            <RefreshCw size={16} />
            Refresh funding
          </button>
        )}
      </div>
      <p className="field-hint">
        Confirmed incoming token transfers, separate from merchant payment
        receipts.
      </p>
      {historyComplete === false && status === "available" && (
        <p className="notice" role="status">
          Older funding history is temporarily unavailable. Only the transfers
          we could verify are shown. Refresh to check again.
        </p>
      )}
      {!hasWallet ? (
        <p className="notice">
          Funding history becomes available once your wallet is ready.
        </p>
      ) : error ? (
        <div className="notice error" role="alert">
          {error}
        </div>
      ) : status === "pending_setup" ? (
        <p className="notice" role="status">
          Your wallet is saved. Funding history will be available when the
          payment service is ready.
        </p>
      ) : status === "unavailable" ? (
        <p className="notice" role="status">
          Funding history couldn’t be retrieved. Refresh to try again.
        </p>
      ) : transfers === null ? (
        <div
          className="funding-loading"
          role="status"
          aria-label="Loading funding transfers"
        >
          <span />
          <span />
          <span />
        </div>
      ) : transfers.length === 0 ? (
        <p className="notice">
          {historyComplete === false
            ? "No transfers were returned by the available history source."
            : "Your confirmed incoming transfers will appear here."}
        </p>
      ) : (
        <div className="ledger" role="list">
          {transfers.map((t) => {
            const url = safeExternalUrl(t.explorerUrl);
            return (
              <article className="payment-row" role="listitem" key={t.id}>
                <span className="payment-icon">
                  <ArrowDownLeft size={20} />
                </span>
                <div className="payment-description">
                  <h3>
                    {/^0x0{40}$/i.test(t.from)
                      ? "Test-token funding"
                      : "Incoming transfer"}
                  </h3>
                  <time dateTime={t.createdAt}>
                    {new Date(t.createdAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                </div>
                <span className="status status-confirmed">
                  <span />
                  Confirmed
                </span>
                <div className="payment-amount">
                  +{formatAmount(t.amount, t.decimals)} <span>{t.symbol}</span>
                </div>
                {url ? (
                  <a
                    className="icon-button"
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="View funding transaction"
                  >
                    <ExternalLink size={18} />
                  </a>
                ) : (
                  <span className="receipt-pending">—</span>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
