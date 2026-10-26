// Helper for manual experiments: open the page headlessly, send one feedback message, close.
// usage: tsx verify/click-feedback.ts <url> "<text>" [--keep-open-ms N]
import { chromium } from "playwright";

const [url, text = "hello from playwright", , keep = "500"] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url);
await page.locator("#status", { hasText: "connected" }).waitFor();
console.log("agent badge:", await page.locator("#agent").textContent());
await page.fill("#feedback", text);
await page.click("#send");
await page.locator("#log", { hasText: "queued feedback" }).waitFor();
await page.waitForTimeout(Number(keep));
await browser.close();
console.log("sent:", text);
