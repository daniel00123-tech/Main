import { chromium } from "playwright";

const pages = [
  ["portal-01-login", "/portal/login"],
  ["portal-02-dashboard", "/portal/dashboard"],
  ["portal-03-connectors", "/portal/connectors"],
  ["portal-04-billing", "/portal/billing"],
  ["portal-05-usage", "/portal/usage"],
  ["portal-06-team", "/portal/team"],
  ["portal-07-ai-connections", "/portal/ai-connections"],
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

for (const [name, path] of pages) {
  await page.goto(`http://127.0.0.1:5173${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.screenshot({
    path: `/opt/cursor/artifacts/screenshots/${name}.png`,
    fullPage: true,
  });
  console.log(`Saved ${name}.png`);
}

await browser.close();
