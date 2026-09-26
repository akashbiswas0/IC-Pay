import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  Copy,
  Link2,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  WifiOff,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  ApiError,
  request,
  type Config,
  type Connection,
  type Dashboard,
} from "./api";
import Brand from "./Brand";

type DeviceLink = {
  id: string;
  userCode: string;
  deviceSecret: string;
  expiresAt: string;
};
type PollResult = { status: "pending" } | { status: "approved" };
type Phase =
  | "ready"
  | "creating"
  | "waiting"
  | "opening"
  | "expired"
  | "error"
  | "account-error";
const anonymous: Connection = {
  base: import.meta.env.VITE_API_URL ?? "",
  token: "",
};

export default function Connect({
  onConnect,
}: {
  onConnect: (connection: Connection, data: Dashboard, config: Config) => void;
}) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [link, setLink] = useState<DeviceLink | null>(null);
  const [now, setNow] = useState(Date.now());
  const [interrupted, setInterrupted] = useState(false);
  const [copied, setCopied] = useState(false);
  const connection = useRef<Connection | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const onConnected = useRef(onConnect);
  onConnected.current = onConnect;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);

  async function openAccount(c: Connection, epoch: number) {
    setPhase("opening");
    try {
      const [data, config] = await Promise.all([
        request<Dashboard>(c, "/v1/dashboard"),
        request<Config>(c, "/v1/config"),
      ]);
      if (!mounted.current || epoch !== generation.current) return;
      onConnected.current(c, data, config);
    } catch (error) {
      if (!mounted.current || epoch !== generation.current) return;
      if (error instanceof ApiError && error.status === 401) {
        connection.current = null;
        setPhase("expired");
      } else setPhase("account-error");
    }
  }

  async function begin() {
    const epoch = ++generation.current;
    connection.current = null;
    setLink(null);
    setInterrupted(false);
    setCopied(false);
    setPhase("creating");
    try {
      const created = await request<DeviceLink>(anonymous, "/v1/device-links", {
        method: "POST",
        body: "{}",
      });
      if (!mounted.current || epoch !== generation.current) return;
      if (
        !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(created.userCode) ||
        !created.id ||
        !created.deviceSecret ||
        !Number.isFinite(Date.parse(created.expiresAt))
      )
        throw new Error("Invalid connection response");
      setNow(Date.now());
      setLink(created);
      setPhase(
        Date.parse(created.expiresAt) > Date.now() ? "waiting" : "expired",
      );
    } catch {
      if (mounted.current && epoch === generation.current) setPhase("error");
    }
  }

  useEffect(() => {
    if (phase !== "waiting" || !link) return;
    const controller = new AbortController();
    const epoch = generation.current;
    let timer: number | undefined;
    const clock = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= Date.parse(link.expiresAt)) setPhase("expired");
    }, 1000);
    async function poll() {
      if (Date.now() >= Date.parse(link!.expiresAt)) {
        setPhase("expired");
        return;
      }
      try {
        const result = await request<PollResult>(
          anonymous,
          `/v1/device-links/${encodeURIComponent(link!.id)}/poll`,
          {
            method: "POST",
            body: JSON.stringify({
              deviceSecret: link!.deviceSecret,
              browser: true,
            }),
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15000),
            ]),
          },
        );
        if (controller.signal.aborted || epoch !== generation.current) return;
        setInterrupted(false);
        if (result.status === "approved") {
          const approved = { ...anonymous };
          connection.current = approved;
          // The account session is an HttpOnly cookie; no bearer token is returned to this page.
          await openAccount(approved, epoch);
          return;
        }
        timer = window.setTimeout(() => void poll(), 2500);
      } catch (error) {
        if (controller.signal.aborted || epoch !== generation.current) return;
        if (
          error instanceof ApiError &&
          [401, 404, 410].includes(error.status)
        ) {
          setPhase("expired");
          return;
        }
        setInterrupted(true);
        timer = window.setTimeout(() => void poll(), 5000);
      }
    }
    timer = window.setTimeout(() => void poll(), 1000);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      window.clearInterval(clock);
    };
  }, [phase, link]);

  const seconds = link
    ? Math.max(0, Math.ceil((Date.parse(link.expiresAt) - now) / 1000))
    : 0;
  const expiresIn = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const nativeLink = link
    ? `suicapay://connect?code=${encodeURIComponent(link.userCode)}`
    : "";
  return (
    <div className="setup-page">
      <header>
        <Brand />
        <span className="environment">Test network</span>
      </header>
      <main className="setup-layout pairing-layout">
        <section className="setup-intro">
          <span className="round-icon">
            <Link2 size={28} />
          </span>
          <h1>
            Your card.
            <br />
            Your account, in view.
          </h1>
          <p>
            Check your balance, follow payments, and choose what your linked
            Suica can spend.
          </p>
          <div className="setup-explainer">
            <Smartphone size={22} />
            <div>
              <h2>New to IC Pay?</h2>
              <p>
                Start in the iPhone app. Link your physical Suica, verify with
                World, and set up your payment account.
              </p>
            </div>
          </div>
          <p className="footnote">
            Your Suica’s yen balance stays separate. Payments here use test
            tokens that are not backed by yen.
          </p>
        </section>
        <section
          className="connection-panel pairing-panel"
          aria-labelledby="connect-heading"
          aria-busy={phase === "creating" || phase === "opening"}
        >
          <h2 id="connect-heading">
            {phase === "waiting"
              ? "Approve this browser"
              : phase === "opening"
                ? "You’re connected"
                : "Connect with your iPhone"}
          </h2>
          {(phase === "ready" || phase === "creating" || phase === "error") && (
            <>
              <p>
                Already using IC Pay? Open your account here with a quick
                approval in the app.
              </p>
              <div className="pairing-start">
                <Smartphone size={32} aria-hidden="true" />
                <div>
                  <strong>Your account stays with you</strong>
                  <p>
                    Use the iPhone where you’re signed in. You won’t need to
                    enter a password.
                  </p>
                </div>
              </div>
              {phase === "error" && (
                <div className="notice error" role="alert">
                  <WifiOff size={20} />
                  <p>
                    We couldn’t connect right now. Check your connection and try
                    again.
                  </p>
                </div>
              )}
              <button
                className="primary full"
                onClick={() => void begin()}
                disabled={phase === "creating"}
              >
                {phase === "creating"
                  ? "Getting your code…"
                  : phase === "error"
                    ? "Try again"
                    : "Get a connection code"}
                <ArrowRight size={18} />
              </button>
            </>
          )}
          {phase === "waiting" && link && (
            <>
              <p>Scan with your iPhone camera, then approve in IC Pay.</p>
              <div className="pairing-qr">
                <QRCodeSVG
                  value={nativeLink}
                  size={184}
                  marginSize={4}
                  level="M"
                  title="Scan with your iPhone to connect this browser"
                />
              </div>
              <p className="pairing-instructions">
                Or open <strong>Account → Connect another device</strong> in the
                app and enter this code:
              </p>
              <div className="pairing-code-row">
                <code
                  className="pairing-code"
                  aria-label={`Connection code ${link.userCode.split("").join(" ")}`}
                >
                  {link.userCode}
                </code>
                <button
                  className="icon-button"
                  aria-label={copied ? "Code copied" : "Copy connection code"}
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(link.userCode)
                      .then(() => setCopied(true))
                      .catch(() => setCopied(false));
                  }}
                >
                  {copied ? <Check size={18} /> : <Copy size={18} />}
                </button>
              </div>
              <p className="pairing-expiry">Expires in {expiresIn}</p>
              <a className="secondary full pairing-open-app" href={nativeLink}>
                Open IC Pay <ArrowRight size={17} />
              </a>
              <div
                className={`pairing-wait ${interrupted ? "pairing-interrupted" : ""}`}
                role="status"
              >
                {interrupted ? (
                  <>
                    <WifiOff size={17} />
                    Connection interrupted. Reconnecting…
                  </>
                ) : (
                  <>
                    <span className="waiting-dot" aria-hidden="true" />
                    Waiting for your approval
                  </>
                )}
              </div>
              <button className="quiet full" onClick={() => void begin()}>
                Use a new code
              </button>
            </>
          )}
          {phase === "opening" && (
            <div className="pairing-opening" role="status">
              <ShieldCheck size={32} />
              <p>Opening your account…</p>
              <div className="funding-loading" aria-hidden="true">
                <span />
                <span />
              </div>
            </div>
          )}
          {phase === "expired" && (
            <div className="pairing-retry">
              <RefreshCw size={28} />
              <h3>This code is no longer available</h3>
              <p>
                Get a fresh code to connect this browser. Your account is safe.
              </p>
              <button className="primary full" onClick={() => void begin()}>
                Get a new code
              </button>
            </div>
          )}
          {phase === "account-error" && (
            <div className="pairing-retry">
              <WifiOff size={28} />
              <h3>Your approval was received</h3>
              <p>
                We couldn’t load your account just yet. You can try again
                without another approval.
              </p>
              <button
                className="primary full"
                onClick={() => {
                  if (connection.current)
                    void openAccount(connection.current, generation.current);
                }}
              >
                Open account again
              </button>
            </div>
          )}
          <div className="connection-note">
            <ShieldCheck size={18} />
            <span>Only approve a connection you started yourself.</span>
          </div>
        </section>
      </main>
      <footer>
        <span>Suica-linked payments</span>
        <span>World verification · Curvegrid activity</span>
      </footer>
    </div>
  );
}
