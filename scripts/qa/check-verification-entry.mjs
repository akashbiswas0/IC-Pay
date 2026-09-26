const base = process.argv[2];
if (!base)
  throw new Error(
    "Usage: node scripts/qa/check-verification-entry.mjs HTTPS_ORIGIN",
  );
const r = await fetch(new URL("/verify", base), {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
  },
});
const text = await r.text();
const warning =
  /You are about to visit|ngrok-skip-browser-warning|ngrok\.com\/abuse|ERR_NGROK_6024/i.test(
    text,
  );
const app = /<title>Suica Pay/.test(text) && /\/assets\//.test(text);
console.log(
  JSON.stringify({
    status: r.status,
    hostingInterstitial: warning,
    applicationHTML: app,
  }),
);
if (!r.ok || warning || !app) process.exitCode = 1;
