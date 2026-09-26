import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  CreditCard,
  ExternalLink,
  History,
  Gift,
  LayoutDashboard,
  LogOut,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Snowflake,
  Smartphone,
  WifiOff,
} from "lucide-react";
import {
  ApiError,
  request,
  type Config,
  type Connection,
  type Dashboard,
  type LinkedCard,
  type Payment,
  type Policy,
} from "./api";
import { formatAmount, parseAmount, safeExternalUrl } from "./money";
import Funding from "./Funding";
import Rewards from "./Rewards";
import Loyalty from "./Loyalty";
import Brand from "./Brand";
import Connect from "./Connect";
import {
  decodeSpendingDraft,
  draftMatchesPolicy,
  newSpendingDraft,
  parsePointsLimit,
  spendingDraftKey,
} from "./spending-state";

type Section = "overview" | "activity" | "spending" | "rewards";
const statusLabels: Record<string, string> = {
  awaiting_tap: "Awaiting tap",
  authorised: "Authorised",
  submitting: "Submitting",
  pending: "Pending",
  reconciling: "Checking settlement",
  confirmed: "Paid",
  failed: "Failed",
  expired: "Expired",
  cancelled: "Cancelled",
};
function paymentProblem(code?: string | null): string | null {
  if (!code) return null;
  const reasons: Record<string, string> = {
    insufficient_gas: "Fund the wallet with native gas before trying again.",
    insufficient_tokens: "The wallet needs more test tokens.",
    insufficient_allowance: "Approve the spending allowance in the iPhone app.",
    invoice_expired: "This invoice expired before payment could be submitted.",
    spending_disabled_before_signing:
      "Spending permission or card access changed before signing.",
    transaction_reverted: "The blockchain rejected this transaction.",
    submission_unknown:
      "Settlement is still being checked. Do not collect this payment again.",
    reconciliation_unavailable:
      "The network is unavailable. Settlement will be checked again.",
    chain_reorganization:
      "The network changed. Confirmation is being checked again.",
  };
  return (
    reasons[code] ??
    "This payment needs attention. Check its status before trying again."
  );
}
function Status({ status }: { status: string }) {
  return (
    <span className={`status status-${status}`}>
      <span aria-hidden="true" />
      {statusLabels[status] ?? status.replaceAll("_", " ")}
    </span>
  );
}
function ErrorNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="notice error" role="alert">
      <WifiOff size={19} />
      <div>{children}</div>
    </div>
  );
}
function PaymentList({
  payments,
  limit,
}: {
  payments: Payment[];
  limit?: number;
}) {
  const rows = limit ? payments.slice(0, limit) : payments;
  if (!rows.length)
    return (
      <div className="empty-ledger">
        <History size={26} />
        <h3>Your receipts will appear here</h3>
        <p>
          After a card tap, follow the payment from processing to confirmation.
          Only confirmed transfers count as paid.
        </p>
      </div>
    );
  return (
    <div className="ledger" role="list">
      {rows.map((payment) => {
        const url = safeExternalUrl(payment.explorerUrl);
        return (
          <article role="listitem" className="payment-row" key={payment.id}>
            <span className="payment-icon">
              <ArrowUpRight size={20} />
            </span>
            <div className="payment-description">
              <h3>{payment.merchantName}</h3>
              <time dateTime={payment.createdAt}>
                {new Date(payment.createdAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>
              {payment.errorCode && (
                <p className="payment-problem">
                  {paymentProblem(payment.errorCode)}
                </p>
              )}
            </div>
            <Status status={payment.status} />
            <div className="payment-amount">
              {formatAmount(payment.amount, payment.decimals)}{" "}
              <span>{payment.symbol}</span>
              {payment.discountAmount &&
                BigInt(payment.discountAmount) > 0n && (
                  <p className="reward-payment-saving">
                    Reward saved{" "}
                    {formatAmount(payment.discountAmount, payment.decimals)}{" "}
                    {payment.symbol}
                  </p>
                )}
            </div>
            {url ? (
              <a
                className="icon-button"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`View ${payment.merchantName} transaction`}
              >
                <ExternalLink size={18} />
              </a>
            ) : (
              <span
                className="receipt-pending"
                title="A confirmed explorer receipt is not available yet"
              >
                —
              </span>
            )}
          </article>
        );
      })}
    </div>
  );
}
function Spending({
  data,
  card,
  config,
  connection,
  refresh,
  onPolicySaved,
}: {
  data: Dashboard;
  card: LinkedCard;
  config: Config;
  connection: Connection;
  refresh: () => Promise<void>;
  onPolicySaved: (policy: Policy) => void;
}) {
  const p = card.policy;
  const requiresApproval =
    p?.requiresApproval === true ||
    Boolean(
      p &&
      config.paymentRouter?.address &&
      p.routerAddress !== config.paymentRouter.address,
    );
  const decimals = config.token.decimals;
  const remaining = p
    ? (BigInt(p.totalLimit) - BigInt(p.spent) - BigInt(p.reserved)).toString()
    : null;
  const draftKey = spendingDraftKey(
    connection.base,
    `${data.account.id}:card:${card.id}`,
  );
  const saveController = useRef<AbortController | null>(null);
  useEffect(() => () => saveController.current?.abort(), []);
  const [initialDraft] = useState(() => {
    try {
      return decodeSpendingDraft(sessionStorage.getItem(draftKey));
    } catch {
      return null;
    }
  });
  const dirty = useRef(Boolean(initialDraft));
  const initial = initialDraft ?? newSpendingDraft(p, decimals);
  const [perPayment, setPerPayment] = useState(initial.perPayment);
  const [total, setTotal] = useState(initial.total);
  const [expiry, setExpiry] = useState(initial.expiry);
  const [merchantScope, setMerchantScope] = useState(initial.merchantScope);
  const [selected, setSelected] = useState<string[]>(initial.selected);
  const [useRewards, setUseRewards] = useState(initial.useRewards);
  const [maxPointsPerPayment, setMaxPointsPerPayment] = useState(
    initial.maxPointsPerPayment,
  );
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const policyFingerprint = JSON.stringify([
    p?.enabled,
    p?.perPaymentLimit,
    p?.totalLimit,
    p?.expiresAt,
    p?.merchantIds,
    p?.merchantScope,
    p?.useRewards,
    p?.maxPointsPerPayment,
    p?.routerAddress,
  ]);
  useEffect(() => {
    if (dirty.current) return;
    const values = newSpendingDraft(p, decimals);
    setPerPayment(values.perPayment);
    setTotal(values.total);
    setExpiry(values.expiry);
    setSelected(values.selected);
    setMerchantScope(values.merchantScope);
    setUseRewards(values.useRewards);
    setMaxPointsPerPayment(values.maxPointsPerPayment);
    setConsent(false);
  }, [policyFingerprint, decimals]);
  useEffect(() => {
    if (!dirty.current) return;
    if (
      draftMatchesPolicy(
        {
          perPayment,
          total,
          expiry,
          selected,
          useRewards,
          merchantScope,
          maxPointsPerPayment,
        },
        p,
        decimals,
      )
    ) {
      dirty.current = false;
      try {
        sessionStorage.removeItem(draftKey);
      } catch {}
      return;
    }
    try {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({
          perPayment,
          total,
          expiry,
          selected,
          useRewards,
          maxPointsPerPayment,
          merchantScope,
        }),
      );
    } catch {
      setError(
        "Your draft could not be saved in this browser. Keep this screen open until you save it.",
      );
    }
  }, [
    draftKey,
    perPayment,
    total,
    expiry,
    selected,
    useRewards,
    maxPointsPerPayment,
    merchantScope,
  ]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const controller = new AbortController();
    saveController.current = controller;
    setError("");
    setSaved("");
    setBusy(true);
    try {
      if (requiresApproval)
        throw new Error(
          "Approve the upgraded rewards wallet in the iPhone app before saving these settings.",
        );
      if (!consent)
        throw new Error(
          "Review and accept the spending permission before saving.",
        );
      if (!config.capabilities.payments)
        throw new Error(
          "Payments aren’t ready yet. Your wallet and linked card are saved.",
        );
      const per = parseAmount(perPayment, decimals),
        cap = parseAmount(total, decimals);
      if (BigInt(per) > BigInt(cap))
        throw new Error(
          "The per-payment limit must be within your total budget.",
        );
      if (merchantScope === "selected" && !selected.length)
        throw new Error(
          "This older draft has no permitted shops. Choose ‘Use all participating shops’ to review new permission.",
        );
      const confirmed = await request<Policy>(connection, "/v1/policy", {
        method: "PUT",
        signal: controller.signal,
        body: JSON.stringify({
          cardId: card.id,
          enabled: true,
          perPaymentLimit: per,
          totalLimit: cap,
          expiresAt: new Date(expiry).toISOString(),
          merchantScope,
          merchantIds: merchantScope === "all" ? [] : selected,
          useRewards,
          ...(config.capabilities.loyalty
            ? { maxPointsPerPayment: parsePointsLimit(maxPointsPerPayment) }
            : {}),
        }),
      });
      if (controller.signal.aborted) return;
      dirty.current = false;
      try {
        sessionStorage.removeItem(draftKey);
      } catch {}
      onPolicySaved(confirmed);
      setSaved("Automatic payments are enabled with these limits.");
      setConsent(false);
      await refresh();
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : "Could not save spending settings.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      {requiresApproval && (
        <p className="notice">
          Approve the upgraded rewards wallet in the iPhone app. Your saved
          limits and earlier rewards remain unchanged.
        </p>
      )}
      <div className="section-heading">
        <h2>Automatic payments</h2>
        <span className="status">
          {p?.enabled
            ? Date.parse(p.expiresAt) > Date.now()
              ? card.allowanceSufficient === true
                ? "Enabled"
                : "Wallet approval required"
              : "Expired"
            : "Off"}
        </span>
      </div>
      <p>
        Approve spending here before you tap. The enrolled merchant can collect
        payment without another confirmation on your phone.
      </p>
      {card.allowanceSufficient !== true && (
        <p className="notice">
          Approve this Suica’s wallet allowance in the iPhone app before
          enabling payments here.
        </p>
      )}
      {p && (
        <p className="policy-summary">
          Remaining {formatAmount(remaining!, decimals)} {config.token.symbol}.
          Pending {formatAmount(p.reserved, decimals)} {config.token.symbol}.
          Spent {formatAmount(p.spent, decimals)} of{" "}
          {formatAmount(p.totalLimit, decimals)} {config.token.symbol}.
          Permission expires {new Date(p.expiresAt).toLocaleString()}. Current
          permission covers{" "}
          {p.merchantScope === "all"
            ? "all participating shops, including shops that join later."
            : "only your previously selected shops."}
        </p>
      )}
      <form
        className="spending-form"
        onSubmit={save}
        onChangeCapture={() => {
          dirty.current = true;
          setConsent(false);
          setSaved("");
        }}
      >
        <div className="field-pair">
          <div>
            <label htmlFor="per-payment">
              Per purchase, before rewards ({config.token.symbol})
            </label>
            <input
              id="per-payment"
              disabled={busy}
              inputMode="decimal"
              value={perPayment}
              onChange={(e) => setPerPayment(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="total-budget">
              Total charged budget ({config.token.symbol})
            </label>
            <input
              id="total-budget"
              disabled={busy}
              inputMode="decimal"
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              required
            />
          </div>
        </div>
        <label htmlFor="expires">Allow payments until</label>
        <input
          id="expires"
          disabled={busy}
          type="datetime-local"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          required
        />
        <div className="permission-scope">
          <h3>
            {merchantScope === "all"
              ? "All participating shops"
              : "Restored shop permission"}
          </h3>
          <p className="field-hint">
            {merchantScope === "all"
              ? "These limits apply at every participating shop, including shops that join later."
              : "This saved draft still covers only your previously selected shops. Retrying it keeps that permission unchanged."}
          </p>
          {merchantScope === "selected" && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                dirty.current = true;
                setMerchantScope("all");
                setSelected([]);
                setConsent(false);
                setSaved("");
              }}
            >
              Use all participating shops
            </button>
          )}
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={useRewards}
            onChange={(e) => setUseRewards(e.target.checked)}
            disabled={
              busy ||
              !(
                config.capabilities.rewards ||
                config.capabilities.collectibles ||
                config.capabilities.loyalty
              )
            }
          />
          <span>
            Allow eligible rewards to be used when this Suica is tapped at a
            permitted shop.
          </span>
        </label>
        <p className="field-hint">
          A reward is used only when the merchant requests it. The payment and
          reward redemption must both succeed.
        </p>
        {config.capabilities.loyalty && (
          <div className="field">
            <label htmlFor="points-limit">Maximum points per purchase</label>
            <input
              id="points-limit"
              inputMode="numeric"
              value={maxPointsPerPayment}
              onChange={(event) => setMaxPointsPerPayment(event.target.value)}
              placeholder="Use available points"
              disabled={busy || !useRewards}
              aria-describedby="points-limit-help"
            />
            <p className="field-hint" id="points-limit-help">
              Leave blank for automatic use, or enter a whole number. Zero keeps
              your points. One point covers 1 {config.token.symbol} at the
              issuing shop. Earlier voucher credit is separate.
            </p>
          </div>
        )}
        <label className="check-row consent">
          <input
            type="checkbox"
            checked={consent}
            disabled={busy}
            onChange={(e) => setConsent(e.target.checked)}
          />
          <span>
            I allow{" "}
            {merchantScope === "all"
              ? "all participating shops, including shops that join later,"
              : "my previously selected shops"}{" "}
            to collect test-token payments within these limits when my card is
            scanned. I can freeze future payments at any time.
          </span>
        </label>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        {saved && (
          <p className="notice success" role="status">
            <Check size={18} />
            {saved}
          </p>
        )}
        <button
          className="primary"
          disabled={
            busy ||
            !consent ||
            !card.wallet ||
            !data.account.verified ||
            !config.capabilities.payments
          }
        >
          {busy
            ? "Saving…"
            : p?.enabled
              ? "Save spending changes"
              : "Enable automatic payments"}
        </button>
      </form>
    </section>
  );
}
export default function App() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [booting, setBooting] = useState(true);
  const [data, setData] = useState<Dashboard | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [section, setSection] = useState<Section>("overview");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [freezeConfirm, setFreezeConfirm] = useState<string | null>(null);
  const [selectedCardID, setSelectedCardID] = useState<string | null>(null);
  const [moneyBusy, setMoneyBusy] = useState(false);
  const isCustomer = data?.account.role === "customer";
  const selectedCard = isCustomer
    ? (data?.cards?.find((card) => card.id === selectedCardID) ??
      data?.cards?.[0] ??
      null)
    : null;
  const currentCardID = useRef<string | null>(null);
  currentCardID.current = selectedCard?.id ?? null;
  const currentData = useRef(data);
  currentData.current = data;
  useEffect(() => {
    setFreezeConfirm(null);
  }, [selectedCard?.id]);
  const stateRevision = useRef(0);
  const currentConnection = useRef(connection);
  currentConnection.current = connection;
  useEffect(() => {
    const controller = new AbortController();
    const existing = { base: import.meta.env.VITE_API_URL ?? "", token: "" };
    Promise.all([
      request<Dashboard>(existing, "/v1/dashboard", {
        signal: controller.signal,
      }),
      request<Config>(existing, "/v1/config", { signal: controller.signal }),
    ])
      .then(([dashboard, configuration]) => {
        if (controller.signal.aborted) return;
        setConnection(existing);
        setData(dashboard);
        setConfig(configuration);
        setUpdated(new Date());
      })
      .catch(() => {
        // An absent or expired browser session returns to phone approval, without exposing credentials.
      })
      .finally(() => {
        if (!controller.signal.aborted) setBooting(false);
      });
    return () => controller.abort();
  }, []);
  async function disconnect() {
    if (!connection) return;
    setBusy(true);
    try {
      await request(connection, "/v1/logout", { method: "POST" });
      if (data) {
        try {
          sessionStorage.removeItem(
            spendingDraftKey(connection.base, data.account.id),
          );
          for (const card of data.cards ?? []) {
            sessionStorage.removeItem(
              spendingDraftKey(
                connection.base,
                `${data.account.id}:card:${card.id}`,
              ),
            );
          }
        } catch {}
      }
      stateRevision.current += 1;
      currentConnection.current = null;
      setConnection(null);
      setData(null);
      setSelectedCardID(null);
      setSection("overview");
      setError("");
    } catch {
      setError("We couldn’t disconnect this browser. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  const refresh = useCallback(async () => {
    if (!connection) return;
    setBusy(true);
    const revision = stateRevision.current;
    try {
      const result = await request<Dashboard>(connection, "/v1/dashboard");
      if (
        currentConnection.current !== connection ||
        revision !== stateRevision.current
      )
        return;
      setData(result);
      setUpdated(new Date());
      setError("");
    } catch (e) {
      if (
        currentConnection.current !== connection ||
        revision !== stateRevision.current
      )
        return;
      if (e instanceof ApiError && e.status === 401) {
        setConnection(null);
        setData(null);
      } else setError(e instanceof Error ? e.message : "Refresh failed.");
    } finally {
      setBusy(false);
    }
  }, [connection]);
  useEffect(() => {
    if (!connection) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [connection, refresh]);
  async function provisionWallet(claim: boolean) {
    if (!connection || !selectedCard || moneyBusy) return;
    const cardId = selectedCard.id;
    const accountID = data?.account.id;
    const isCurrent = () =>
      currentConnection.current === connection &&
      currentData.current?.account.id === accountID &&
      currentData.current?.cards?.some((card) => card.id === cardId);
    setMoneyBusy(true);
    setError("");
    try {
      const result = await request<{ status: LinkedCard["walletStatus"] }>(
        connection,
        claim ? "/v1/wallet/claim" : "/v1/wallet",
        {
          method: "POST",
          body: JSON.stringify({ cardId }),
        },
      );
      if (!isCurrent()) return;
      stateRevision.current += 1;
      setData((current) =>
        current
          ? {
              ...current,
              unassignedWalletAvailable: claim
                ? false
                : current.unassignedWalletAvailable,
              cards: current.cards?.map((card) =>
                card.id === cardId
                  ? { ...card, walletStatus: result.status }
                  : card,
              ),
            }
          : current,
      );
      await refresh();
    } catch (e) {
      if (isCurrent() && currentCardID.current === cardId)
        setError(
          e instanceof Error
            ? e.message
            : "Could not prepare this Suica’s wallet.",
        );
    } finally {
      setMoneyBusy(false);
    }
  }
  async function freeze() {
    if (
      !connection ||
      !selectedCard ||
      moneyBusy ||
      freezeConfirm !== selectedCard.id
    )
      return;
    const cardId = selectedCard.id;
    const accountID = data?.account.id;
    const isCurrent = () =>
      currentConnection.current === connection &&
      currentData.current?.account.id === accountID &&
      currentData.current?.cards?.some((card) => card.id === cardId);
    setMoneyBusy(true);
    try {
      await request(connection, "/v1/freeze", {
        method: "POST",
        body: JSON.stringify({ cardId }),
      });
      if (!isCurrent()) return;
      stateRevision.current += 1;
      setData((current) =>
        current
          ? {
              ...current,
              cards: current.cards?.map((card) =>
                card.id === cardId && card.policy
                  ? { ...card, policy: { ...card.policy, enabled: false } }
                  : card,
              ),
            }
          : current,
      );
      setFreezeConfirm(null);
      await refresh();
    } catch (e) {
      if (isCurrent() && currentCardID.current === cardId)
        setError(e instanceof Error ? e.message : "Could not freeze payments.");
    } finally {
      setMoneyBusy(false);
    }
  }
  if (booting)
    return (
      <div className="setup-page">
        <header>
          <Brand />
          <span className="environment">Test network</span>
        </header>
        <main className="account-restoring" role="status">
          <ShieldCheck size={30} />
          <h1>Opening IC Pay</h1>
          <p>Checking your account…</p>
        </main>
      </div>
    );
  if (!connection || !data || !config)
    return (
      <Connect
        onConnect={(c, d, cfg) => {
          setSelectedCardID(null);
          setConnection(c);
          setData(d);
          setConfig(cfg);
          setUpdated(new Date());
          setError("");
        }}
      />
    );
  const wallet = isCustomer ? (selectedCard?.wallet ?? null) : data.wallet;
  const policy = isCustomer ? (selectedCard?.policy ?? null) : data.policy;
  const token = wallet ?? config.token;
  const spendingActive = Boolean(
    !policy?.requiresApproval &&
    policy?.enabled &&
    Date.parse(policy.expiresAt) > Date.now() &&
    (!isCustomer || selectedCard?.allowanceSufficient === true),
  );
  const ready =
    isCustomer &&
    selectedCard?.status === "active" &&
    data.account.verified &&
    wallet &&
    spendingActive &&
    config.capabilities.payments;
  const filtered = data.payments.filter(
    (p) =>
      (filter === "all" || p.status === filter) &&
      p.merchantName.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Main navigation">
          {(
            [
              { id: "overview", label: "Overview", Icon: LayoutDashboard },
              { id: "activity", label: "Activity", Icon: History },
              ...(isCustomer || data.merchant
                ? [{ id: "rewards" as const, label: "Rewards", Icon: Gift }]
                : []),
              ...(data.account.role === "customer"
                ? [
                    {
                      id: "spending" as const,
                      label: "Spending",
                      Icon: SlidersHorizontal,
                    },
                  ]
                : []),
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              aria-current={section === id ? "page" : undefined}
              onClick={() => setSection(id)}
            >
              <Icon size={19} />
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="environment">Test network</span>
          <p>Payments powered by Curvegrid</p>
          <button
            className="quiet"
            disabled={busy || moneyBusy}
            onClick={() => void disconnect()}
          >
            <LogOut size={18} />
            Disconnect
          </button>
        </div>
      </aside>
      <main id="main">
        <header className="page-header">
          <div>
            <p className="page-context">
              {data.merchant?.name ?? "Your payment account"}
            </p>
            <h1>
              {section === "overview"
                ? "Overview"
                : section === "activity"
                  ? "Payment activity"
                  : section === "rewards"
                    ? "Rewards"
                    : "Spending settings"}
            </h1>
          </div>
          <button
            className="secondary refresh"
            aria-label="Refresh account"
            onClick={() => void refresh()}
            disabled={busy || moneyBusy}
          >
            <RefreshCw size={16} className={busy ? "spinning" : ""} />
            <span>{busy ? "Refreshing" : "Refresh"}</span>
          </button>
        </header>
        <div className="sync-line" aria-live="polite">
          {error
            ? "Last retrieved data · refresh failed"
            : updated
              ? `Updated ${updated.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
              : "Waiting for account data"}
          <span>Chain {config.chainId || "not configured"}</span>
        </div>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        {!config.capabilities.payments && (
          <div className="notice">
            <CircleHelp size={20} />
            <div>
              <strong>Payments aren’t ready yet</strong>
              <p>
                Your account details are saved. Funding and payments will be
                available once the payment service is ready.
              </p>
            </div>
          </div>
        )}
        {isCustomer &&
          section !== "activity" &&
          (selectedCard ? (
            <div className="ledger-filters">
              <div>
                <label htmlFor="suica-card">Suica card</label>
                <select
                  id="suica-card"
                  value={selectedCard.id}
                  disabled={moneyBusy}
                  onChange={(event) => {
                    setSelectedCardID(event.target.value);
                    setFreezeConfirm(null);
                    setError("");
                  }}
                >
                  {data.cards?.map((card) => (
                    <option key={card.id} value={card.id}>
                      {card.nickname} · •••• {card.last4}
                      {card.status === "frozen" ? " · Frozen" : ""}
                    </option>
                  ))}
                </select>
                <p className="field-hint">
                  Each Suica has its own crypto balance and spending limits.
                </p>
              </div>
            </div>
          ) : (
            <p className="notice">
              No linked Suica cards. Link a card in the iPhone app to create and
              fund its wallet.
            </p>
          ))}
        {section === "overview" && (
          <>
            <section className="account-summary">
              <div className="wallet-summary">
                <div className="section-heading">
                  <h2>
                    {isCustomer
                      ? selectedCard
                        ? `${selectedCard.nickname} crypto balance`
                        : "No linked Suica"
                      : "Crypto balance"}
                  </h2>
                  <span className="token-label">
                    {config.token.name ?? "IC Stablecoin"}
                  </span>
                </div>
                {wallet ? (
                  <>
                    {wallet.balanceStatus === "available" &&
                    wallet.balance !== null ? (
                      <p className="balance">
                        {formatAmount(wallet.balance, wallet.decimals)}{" "}
                        <span>{wallet.symbol}</span>
                      </p>
                    ) : (
                      <div className="wallet-empty" role="status">
                        <h3>
                          {wallet.balanceStatus === "pending_setup"
                            ? "Your wallet is ready"
                            : "Balance unavailable"}
                        </h3>
                        <p>
                          {wallet.balanceStatus === "pending_setup"
                            ? "Your balance will appear when the payment service is ready."
                            : "We couldn’t retrieve your balance. Refresh to try again. Your wallet is saved."}
                        </p>
                      </div>
                    )}
                    <p className="wallet-address">{wallet.address}</p>
                    <details className="collectible-details">
                      <summary>Token details</summary>
                      <p>
                        {config.token.name ?? "IC Stablecoin"} ({token.symbol})
                        is the app name for this test token. It has no fiat
                        backing.
                      </p>
                      {config.token.onchainSymbol &&
                        config.token.onchainSymbol !== token.symbol && (
                          <p>
                            Blockchain symbol: {config.token.onchainSymbol}. The
                            app label does not convert the balance.
                          </p>
                        )}
                      <p className="collectible-contract">
                        {config.token.address}
                      </p>
                    </details>
                  </>
                ) : (
                  <div className="wallet-empty">
                    <h3>
                      {isCustomer
                        ? !selectedCard
                          ? "Link a Suica to get started"
                          : selectedCard.walletStatus === "provisioning"
                            ? "Preparing this Suica’s wallet"
                            : selectedCard.walletStatus === "needs_attention"
                              ? "Wallet setup needs attention"
                              : selectedCard.walletStatus === "ready"
                                ? "Wallet details unavailable"
                                : "This Suica needs a wallet"
                        : "No wallet for this account"}
                    </h3>
                    <p>
                      {isCustomer
                        ? !selectedCard
                          ? "Add a card in the iPhone app. Each linked Suica has a separate crypto balance."
                          : selectedCard.walletStatus === "none"
                            ? "Create a wallet for this card before adding test tokens."
                            : "Refresh to check this card’s wallet status, or continue setup in the iPhone app."
                        : "Your receiving account is not ready yet. Check its status in the iPhone app."}
                    </p>
                    {isCustomer && selectedCard?.walletStatus === "none" && (
                      <div>
                        <button
                          className="primary"
                          disabled={busy || moneyBusy}
                          onClick={() => void provisionWallet(false)}
                        >
                          {moneyBusy
                            ? "Preparing…"
                            : "Create wallet for this Suica"}
                        </button>
                        {data.unassignedWalletAvailable && (
                          <>
                            <p className="field-hint">
                              An existing wallet is unassigned. Assign it and
                              its funds to this Suica.
                            </p>
                            <button
                              className="secondary"
                              disabled={busy || moneyBusy}
                              onClick={() => void provisionWallet(true)}
                            >
                              Use existing wallet
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <p className="field-hint">
                  Test tokens, not backed by yen. Your Suica balance stays
                  separate.
                </p>
              </div>
              <div className="account-details">
                {isCustomer ? (
                  <>
                    <div>
                      <CreditCard size={20} />
                      <span>Physical Suica</span>
                      <strong>
                        {selectedCard
                          ? `${selectedCard.status === "frozen" ? "Frozen" : "Linked"} · ${selectedCard.last4}`
                          : "Not linked"}
                      </strong>
                    </div>
                    <div>
                      <ShieldCheck size={20} />
                      <span>World verification</span>
                      <strong>
                        {data.account.verified ? "Verified" : "Required"}
                      </strong>
                    </div>
                    <div>
                      <SlidersHorizontal size={20} />
                      <span>Automatic spending</span>
                      <strong>
                        {spendingActive
                          ? "Enabled"
                          : policy?.enabled
                            ? Date.parse(policy.expiresAt) <= Date.now()
                              ? "Expired"
                              : "Wallet approval required"
                            : "Off"}
                      </strong>
                    </div>
                    {policy?.enabled && (
                      <button
                        className="quiet danger-text"
                        onClick={() =>
                          setFreezeConfirm(selectedCard?.id ?? null)
                        }
                      >
                        <Snowflake size={18} />
                        Freeze payments
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <div>
                      <ShieldCheck size={20} />
                      <span>Account access</span>
                      <strong>
                        {data.account.role === "merchant"
                          ? "Merchant"
                          : "Administrator"}
                      </strong>
                    </div>
                    <div>
                      <Smartphone size={20} />
                      <span>Collect payments</span>
                      <strong>Enrolled iPhone</strong>
                    </div>
                  </>
                )}
              </div>
            </section>
            {freezeConfirm && freezeConfirm === selectedCard?.id && (
              <div className="notice freeze-confirm">
                <div>
                  <strong>Freeze future payments?</strong>
                  <p>
                    New payments will stop. A transaction already submitted can
                    still complete.
                  </p>
                </div>
                <button
                  className="secondary"
                  onClick={() => setFreezeConfirm(null)}
                >
                  Keep enabled
                </button>
                <button
                  className="primary"
                  onClick={() => void freeze()}
                  disabled={busy || moneyBusy}
                >
                  Freeze payments
                </button>
              </div>
            )}
            {data.merchant && (
              <section className="merchant-summary">
                <ArrowDownLeft size={22} />
                <div>
                  <h2>Merchant receipts</h2>
                  <p>
                    {data.merchant.confirmedCount} confirmed payments ·{" "}
                    {formatAmount(
                      data.merchant.receivedTotal,
                      config.token.decimals,
                    )}{" "}
                    {config.token.symbol} received
                  </p>
                </div>
                <span>Collect a payment in the iPhone app</span>
              </section>
            )}
            {isCustomer && selectedCard?.wallet && (
              <Funding
                key={`${data.account.id}:${selectedCard.id}`}
                connection={connection}
                hasWallet={true}
                cardId={selectedCard.id}
              />
            )}
            {(isCustomer || data.merchant) && config.capabilities.loyalty && (
              <Loyalty
                key={`points:${data.account.id}:${selectedCard?.id ?? "merchant"}`}
                connection={connection}
                config={config}
                cardId={selectedCard?.id}
                hasWallet={Boolean(wallet)}
                merchant={Boolean(data.merchant)}
                compact
                revision={updated?.getTime()}
              />
            )}
            {(isCustomer || data.merchant) &&
              (config.capabilities.collectibles ||
                config.capabilities.rewards) && (
                <Rewards
                  key={`preview:${data.account.id}:${selectedCard?.id ?? "merchant"}`}
                  connection={connection}
                  config={config}
                  cardId={selectedCard?.id}
                  hasWallet={Boolean(wallet)}
                  merchant={Boolean(data.merchant)}
                  compact
                  revision={updated?.getTime()}
                />
              )}
            <section className="activity-section">
              <div className="section-heading">
                <h2>Recent payments</h2>
                <button
                  className="quiet"
                  onClick={() => setSection("activity")}
                >
                  View all <ChevronRight size={17} />
                </button>
              </div>
              <PaymentList payments={data.payments} limit={6} />
            </section>
            <div className="account-note">
              <Smartphone size={22} />
              <div>
                <h3>
                  {ready
                    ? "Ready for a card tap"
                    : isCustomer &&
                        wallet &&
                        data.account.verified &&
                        selectedCard?.status === "active" &&
                        !config.capabilities.payments
                      ? "Your wallet and card are saved"
                      : isCustomer
                        ? "Finish setup on your iPhone"
                        : "Collect payments on your iPhone"}
                </h3>
                <p>
                  {ready
                    ? "Tap your linked Suica at a participating merchant. Follow the payment here until it’s confirmed."
                    : isCustomer &&
                        wallet &&
                        data.account.verified &&
                        selectedCard?.status === "active" &&
                        !config.capabilities.payments
                      ? "You don’t need to link your card or verify again. Funding and spending will be available when the payment service is ready."
                      : isCustomer
                        ? "Link your card, complete verification, fund your wallet and enable spending before your first payment."
                        : "Use an enrolled merchant account in the iPhone app to create an invoice and read the customer’s card. Confirmed receipts appear here."}
                </p>
              </div>
            </div>
          </>
        )}
        {section === "activity" && (
          <section className="activity-section">
            <div className="ledger-filters">
              <div>
                <label htmlFor="search">Merchant</label>
                <input
                  id="search"
                  type="search"
                  placeholder="Search merchants"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="filter">Status</label>
                <select
                  id="filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">All statuses</option>
                  {Object.entries(statusLabels).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <PaymentList payments={filtered} />
            <p className="field-hint">
              Showing {filtered.length} of {data.payments.length} retrieved
              payments. Processing and failed attempts are separate from
              confirmed receipts.
            </p>
            <Funding
              key={`${data.account.id}:account`}
              connection={connection}
              hasWallet={isCustomer || Boolean(wallet)}
            />
            {isCustomer && (
              <Loyalty
                connection={connection}
                config={config}
                hasWallet={
                  Boolean(data.cards?.some((card) => card.wallet)) ||
                  Boolean(data.unassignedWalletAvailable)
                }
                history
                revision={updated?.getTime()}
              />
            )}
            {isCustomer && (
              <Rewards
                connection={connection}
                config={config}
                hasWallet={
                  Boolean(data.cards?.some((card) => card.wallet)) ||
                  Boolean(data.unassignedWalletAvailable)
                }
                history
                revision={updated?.getTime()}
              />
            )}
          </section>
        )}
        {section === "rewards" && (
          <>
            <Loyalty
              key={`points:${data.account.id}:${selectedCard?.id ?? "merchant"}`}
              connection={connection}
              config={config}
              cardId={selectedCard?.id}
              hasWallet={Boolean(wallet)}
              merchant={Boolean(data.merchant)}
              revision={updated?.getTime()}
            />
            <Rewards
              key={`${data.account.id}:${selectedCard?.id ?? "merchant"}`}
              connection={connection}
              config={config}
              cardId={selectedCard?.id}
              hasWallet={Boolean(wallet)}
              merchant={Boolean(data.merchant)}
              revision={updated?.getTime()}
            />
          </>
        )}
        {section === "spending" && isCustomer && selectedCard && (
          <Spending
            key={`${connection.base}:${data.account.id}:${selectedCard.id}`}
            data={data}
            card={selectedCard}
            config={config}
            connection={connection}
            refresh={refresh}
            onPolicySaved={(policy) => {
              if (
                currentConnection.current !== connection ||
                currentCardID.current !== selectedCard.id
              )
                return;
              stateRevision.current += 1;
              setData((current) =>
                current?.account.id === data.account.id
                  ? {
                      ...current,
                      cards: current.cards?.map((card) =>
                        card.id === selectedCard.id
                          ? { ...card, policy, allowanceSufficient: true }
                          : card,
                      ),
                    }
                  : current,
              );
            }}
          />
        )}
        <footer className="dashboard-footer">
          <span>Suica-linked crypto payments</span>
          <span>World · Curvegrid</span>
        </footer>
      </main>
    </div>
  );
}
