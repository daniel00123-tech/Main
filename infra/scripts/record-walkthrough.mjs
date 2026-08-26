import { chromium } from "playwright";

const tour = [
  ["/", 2500],
  ["/companies", 2000],
  ["/companies/caddington-holdings", 3000],
  ["/companies/ht-business", 2000],
  ["/connectors", 2500],
  ["/mcp-environments", 2500],
  ["/ai-clients", 2000],
  ["/billing", 3000],
  ["/usage", 2000],
  ["/system-health", 2000],
  ["/audit-log", 2000],
];

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: "/opt/cursor/artifacts", size: { width: 1440, height: 900 } },
});
const page = await context.newPage();

for (const [path, delay] of tour) {
  await page.goto(`http://localhost:5173${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(delay);
}

await context.close();
await browser.close();
console.log("Video recording saved to /opt/cursor/artifacts/");
