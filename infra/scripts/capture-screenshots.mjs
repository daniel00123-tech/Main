import { chromium } from "playwright";

const pages = [
  ["01-dashboard", "/"],
  ["02-companies", "/companies"],
  ["03-company-caddington", "/companies/caddington-holdings"],
  ["04-company-ht", "/companies/ht-business"],
  ["05-connectors", "/connectors"],
  ["06-mcp-environments", "/mcp-environments"],
  ["07-ai-clients", "/ai-clients"],
  ["08-billing", "/billing"],
  ["09-usage", "/usage"],
  ["10-system-health", "/system-health"],
  ["11-audit-log", "/audit-log"],
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

for (const [name, path] of pages) {
  await page.goto(`http://localhost:5173${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `/opt/cursor/artifacts/screenshots/${name}.png`, fullPage: true });
  console.log(`Saved ${name}.png`);
}

await browser.close();
