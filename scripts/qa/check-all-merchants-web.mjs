import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
process.umask(0o077);
const origin = "https://main.d21bivg674x6ke.amplifyapp.com";
const { token } = JSON.parse(
  readFileSync(".build/cloud/funding-check-session.json"),
);
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies([
    {
      name: "__Host-suica_session",
      value: token,
      url: origin,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Spending", exact: true })
    .click({ timeout: 45000 });
  await page
    .getByRole("heading", { name: "All participating shops", exact: true })
    .waitFor({ timeout: 15000 });
  if (await page.locator(".merchant-picker,.merchant-grid").count())
    throw Error("Merchant picker remains");
  const content = await page.locator("main").innerText();
  if (!content.includes("including shops that join later"))
    throw Error("Future-shop scope is not clear");
  if (content.includes("Choose at least one merchant"))
    throw Error("Legacy merchant requirement remains");
  mkdirSync(".build/all-merchants", { recursive: true, mode: 0o700 });
  await page.screenshot({
    path: ".build/all-merchants/web-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".build/all-merchants/web-mobile.png",
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  if (overflow) throw Error("Horizontal overflow");
  writeFileSync(
    ".build/all-merchants/web-check.json",
    JSON.stringify({
      authenticated: true,
      allMerchantsVisible: true,
      merchantPickerRemoved: true,
      mobileOverflow: false,
    }),
    { mode: 0o600 },
  );
  console.log(
    "Authenticated spending page passed desktop/mobile all-merchant checks without submitting changes.",
  );
  await context.close();
} finally {
  await browser.close();
}
