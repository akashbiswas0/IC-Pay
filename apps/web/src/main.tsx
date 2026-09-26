import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
const Verify = lazy(() => import("./Verify"));
const isVerify = window.location.pathname === "/verify";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isVerify ? (
      <Suspense
        fallback={
          <main className="verify-page" aria-live="polite">
            Loading verification…
          </main>
        }
      >
        <Verify />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
