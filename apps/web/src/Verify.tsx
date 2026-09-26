import { useEffect, useRef, useState } from "react";
import { type RpContext } from "@worldcoin/idkit-core";
import { createSelfieSession } from "./world-session";
import { QRCodeSVG } from "qrcode.react";
import {
  CheckCircle2,
  CreditCard,
  ExternalLink,
  ShieldCheck,
} from "lucide-react";
import { ApiError, request } from "./api";

type Context = {
  id: string;
  appId: `app_${string}`;
  environment: "staging" | "production";
  sessionId: `session_${string}` | null;
  rpContext: RpContext;
  purpose: "enrollment" | "addition" | "replacement" | "login" | "recovery";
};
// Only this request-scoped handoff capability is kept across a same-tab reload.
// Account cookies remain HttpOnly; proofs and World session identifiers are never stored here.
const handoffKey = "suica-world-handoff-v1";
const startedPrefix = "suica-world-started:";
const maximumHandoffAge = 5 * 60 * 1000;
type Handoff = { requestId: string; token: string; expiresAt: number };
function storedHandoff(): Handoff | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(handoffKey) ?? "null",
    ) as Handoff | null;
    if (
      value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value.requestId,
      ) &&
      /^[A-Za-z0-9_-]{43}$/.test(value.token) &&
      Number.isFinite(value.expiresAt) &&
      value.expiresAt > Date.now() &&
      value.expiresAt <= Date.now() + maximumHandoffAge
    )
      return value;
    sessionStorage.removeItem(handoffKey);
  } catch {
    /* Unavailable storage cannot restore a verification request. */
  }
  return null;
}
function persistHandoff(value: Handoff): boolean {
  try {
    sessionStorage.setItem(handoffKey, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function clearHandoff(requestId?: string) {
  try {
    const raw = sessionStorage.getItem(handoffKey);
    if (!requestId || !raw || JSON.parse(raw).requestId === requestId)
      sessionStorage.removeItem(handoffKey);
  } catch {
    /* Never keep verification UI alive because storage cleanup failed. */
  }
}
function started(requestId: string): boolean {
  try {
    return (
      Number(sessionStorage.getItem(startedPrefix + requestId)) > Date.now()
    );
  } catch {
    return false;
  }
}
function markStarted(value: Handoff) {
  // Keep this non-secret tombstone until expiry even after deleting the capability, so reopening
  // the original link cannot create a second SDK request in this tab with the same RP nonce.
  sessionStorage.setItem(
    startedPrefix + value.requestId,
    String(value.expiresAt),
  );
}
function captureHandoff(): Handoff | null {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (
        key?.startsWith(startedPrefix) &&
        Number(sessionStorage.getItem(key)) <= Date.now()
      )
        sessionStorage.removeItem(key);
    }
  } catch {
    /* A fresh link can still be checked before reporting a storage error. */
  }
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("handoff") ?? params.get("handoffToken");
  const requestId = params.get("requestId")?.toLowerCase();
  const previous = storedHandoff();
  // Always remove the capability from the address bar before loading the World SDK flow.
  window.history.replaceState(null, "", window.location.pathname);
  if (!token && !requestId) return previous;
  if (
    !token ||
    !requestId ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      requestId,
    )
  ) {
    clearHandoff();
    return null;
  }
  const value = {
    requestId,
    token,
    expiresAt:
      previous?.requestId === requestId
        ? previous.expiresAt
        : Date.now() + maximumHandoffAge,
  };
  persistHandoff(value);
  return value;
}
const handoff = captureHandoff();
const requestId = handoff?.requestId ?? "";

export default function Verify() {
  const [context, setContext] = useState<Context | null>(null);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<
    | "loading"
    | "ready"
    | "preparing"
    | "waiting"
    | "verifying"
    | "complete"
    | "failed"
  >("loading");
  const [uri, setUri] = useState("");
  const mounted = useRef(true);
  const running = useRef(false);
  const expiration = useRef<number | undefined>(undefined);
  const connection = {
    base: import.meta.env.VITE_API_URL ?? "",
    token: handoff?.token ?? "",
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    if (!handoff) {
      setError(
        "Open verification from the IC Pay iPhone app. This page needs a fresh, secure verification link.",
      );
      setPhase("failed");
    } else
      request<Context>(connection, `/v1/world/requests/${requestId}/context`, {
        signal: controller.signal,
      })
        .then((value) => {
          if (controller.signal.aborted) return;
          const expiresAt = Math.min(
            handoff.expiresAt,
            value.rpContext.expires_at * 1000,
          );
          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
            throw new Error(
              "This verification link has expired. Return to IC Pay and start again.",
            );
          handoff.expiresAt = expiresAt;
          setContext(value);
          if (started(requestId)) {
            clearHandoff(requestId);
            setError(
              "This page was reloaded and can’t resume World verification. Return to IC Pay to restart this verification securely.",
            );
            setPhase("failed");
            return;
          }
          if (!persistHandoff(handoff))
            throw new Error(
              "Verification needs temporary browser storage. Return to IC Pay and try again with site storage enabled.",
            );
          expiration.current = window.setTimeout(() => {
            clearHandoff(requestId);
            setUri("");
            setError(
              "This verification link has expired. Return to IC Pay and start again.",
            );
            setPhase("failed");
          }, expiresAt - Date.now());
          setPhase("ready");
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            clearHandoff(requestId);
            setError(
              e instanceof ApiError && [404, 409, 410].includes(e.status)
                ? "This verification is no longer available. Return to IC Pay to check its status or start again."
                : e instanceof Error
                  ? e.message
                  : "Verification could not load. Return to IC Pay and start again.",
            );
            setPhase("failed");
          }
        });
    return () => {
      mounted.current = false;
      controller.abort();
      window.clearTimeout(expiration.current);
    };
  }, []);
  async function verify() {
    if (!context || !handoff || running.current) return;
    running.current = true;
    setError("");
    setPhase("preparing");
    try {
      if (handoff.expiresAt <= Date.now())
        throw new Error(
          "This verification link has expired. Return to IC Pay and start again.",
        );
      if (started(requestId))
        throw new Error(
          "This verification has already started. Return to IC Pay to check its status.",
        );
      markStarted(handoff);
      const config = {
        app_id: context.appId,
        rp_context: context.rpContext,
        environment: context.environment,
      };
      if (context.purpose !== "enrollment" && !context.sessionId)
        throw new Error(
          "We couldn’t confirm your existing account. Return to IC Pay and start again.",
        );
      const flow = await createSelfieSession(config, context.sessionId);
      if (!mounted.current) return;
      if (handoff.expiresAt <= Date.now())
        throw new Error(
          "This verification link has expired. Return to IC Pay and start again.",
        );
      const link = new URL(flow.connectorURI);
      if (link.protocol !== "https:")
        throw new Error("World returned an unsupported verification link.");
      setUri(link.href);
      setPhase("waiting");
      const completion = await flow.pollUntilCompletion({
        timeout: Math.max(1, handoff.expiresAt - Date.now()),
        pollInterval: 2000,
      });
      if (!mounted.current) return;
      if (handoff.expiresAt <= Date.now())
        throw new Error(
          "This verification link has expired. Return to IC Pay and start again.",
        );
      if (!completion.success)
        throw new Error(
          `World verification was not completed (${completion.error}). Return to IC Pay and start again.`,
        );
      setPhase("verifying");
      await request(connection, `/v1/world/requests/${requestId}/verify`, {
        method: "POST",
        body: JSON.stringify({ result: completion.result }),
      });
      clearHandoff(requestId);
      window.clearTimeout(expiration.current);
      if (mounted.current) {
        setUri("");
        setPhase("complete");
      }
    } catch (e) {
      clearHandoff(requestId);
      window.clearTimeout(expiration.current);
      if (mounted.current) {
        setUri("");
        setError(
          e instanceof Error ? e.message : "Verification could not complete.",
        );
        setPhase("failed");
      }
    } finally {
      running.current = false;
    }
  }
  return (
    <div className="verify-page">
      <header>
        <a className="brand" href="/">
          <span className="brand-mark">
            <CreditCard size={22} />
          </span>
          IC Pay
        </a>
      </header>
      <main>
        <span className="round-icon">
          <ShieldCheck size={28} />
        </span>
        <h1 style={{ marginTop: "1.5rem" }}>
          {context?.purpose === "recovery"
            ? "Recover your account"
            : context?.purpose === "login"
              ? "Confirm sign-in"
              : context?.purpose === "replacement"
                ? "Confirm it’s you"
                : context?.purpose === "addition"
                  ? "Add Suica card"
                  : "Verify your account"}
        </h1>
        <p>
          {context?.purpose === "recovery"
            ? "Verify with World to recover your existing wallet. Removed cards stay removed."
            : context?.purpose === "login"
              ? "Confirm it’s you with World to sign in to your existing IC Pay account."
              : context?.purpose === "replacement"
                ? "Use your existing World identity to protect this card replacement. Your current card stays linked until verification succeeds."
                : context?.purpose === "addition"
                  ? "Verify with World to add this card. Your existing cards stay linked."
                  : "Complete a Selfie Check with World to finish linking your physical Suica."}
        </p>
        {context?.environment === "staging" && (
          <div className="notice">
            World staging environment · test verification
          </div>
        )}
        <div aria-live="polite">
          {phase === "loading" && (
            <p className="notice">Loading your secure verification request…</p>
          )}
          {phase === "ready" && (
            <button
              className="primary full verify-action"
              onClick={() => void verify()}
            >
              Continue with World <ExternalLink size={17} />
            </button>
          )}
          {phase === "preparing" && (
            <p className="notice">Creating your World request…</p>
          )}
          {phase === "waiting" && (
            <>
              <div className="qr">
                <QRCodeSVG
                  value={uri}
                  size={216}
                  marginSize={1}
                  title="Scan with World ID App to verify"
                />
              </div>
              <a
                className="primary full"
                href={uri}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open World ID App <ExternalLink size={17} />
              </a>
              <p className="field-hint">
                Or scan with another phone. Keep this page open while you
                verify, then return here. Don’t reload it.
              </p>
            </>
          )}
          {phase === "verifying" && (
            <p className="notice">Confirming your verification…</p>
          )}
          {phase === "complete" && (
            <div className="verify-success">
              <CheckCircle2 size={40} />
              <h2>Verification complete</h2>
              <p>
                Return to IC Pay on your iPhone. Your account will update
                automatically.
              </p>
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {(phase === "failed" || phase === "complete") && (
            <a
              className="primary full verify-action"
              href="suicapay://verify-return"
            >
              Return to IC Pay
            </a>
          )}
        </div>
        <p className="footnote" style={{ marginTop: "2rem" }}>
          World checks protect account setup, sign-in, and card replacement. You
          won’t need to verify again at checkout.
        </p>
      </main>
    </div>
  );
}
