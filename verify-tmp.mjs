import { chromium } from "playwright";

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
const errors = [];
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
page.on("pageerror", (err) => errors.push(String(err)));

await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForSelector("text=Analyze", { timeout: 15000 });

// Default symbol is BTC; wait for its analysis to load.
await page.waitForSelector("text=BTC LTF Analysis", { timeout: 20000 });
await page.waitForFunction(() => document.body.innerText.includes("24h volume"), { timeout: 20000 });

const statsText = await page.locator("text=24h volume").first().locator("xpath=..").innerText();
console.log("Stats grid snippet:", statsText.replace(/\s+/g, " "));

await page.screenshot({ path: "/tmp/claude-0/-data-data-com-termux-files-home-projects-trading/a7d2097f-9f14-4574-a52e-17033f796e20/scratchpad/coin-analysis.png", fullPage: true });

console.log("Console errors:", errors.length ? errors : "none");
await browser.close();
