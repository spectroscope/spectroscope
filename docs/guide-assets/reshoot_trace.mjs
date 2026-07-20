// Targeted re-shoot of the two trace screenshots after the proto-column /
// open-at-top / jump-rail / resume-wording changes. Same context settings as
// capture_screens.mjs (1600x1000 @1.5, dark, EN chrome); runs against the vite
// dev server on :5199 (same UI code, /api + /ws proxied to :8080).
import { chromium } from "playwright";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "shots");
const BASE = process.env.BASE_URL || "http://localhost:5199";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1.5,
  colorScheme: "dark",
});
await ctx.addInitScript(() => { try { localStorage.setItem("spectroscope:lang", "en"); } catch {} });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.split("\n")[0]));

const jsClick = (sel, nth = 0) => page.evaluate(([s, n]) => {
  const els = document.querySelectorAll(s);
  if (!els[n]) throw new Error("no element " + s + " #" + n);
  els[n].click();
}, [sel, nth]);
const jsClickByText = (sel, text) => page.evaluate(([s, t]) => {
  const el = [...document.querySelectorAll(s)].find(e => e.textContent.includes(t));
  if (!el) throw new Error("no " + s + " containing " + t);
  el.click();
}, [sel, text]);
const shoot = async (name) => {
  await page.waitForTimeout(550);
  await page.screenshot({ path: join(OUT, name + ".png") });
  console.log("shot:", name);
};

// ---------- 11-trace: the coding scenario, fully drained, Trace tab ----------
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
await jsClick(".sidebar-scenarios");
await page.waitForSelector(".scn-modal");
await jsClick(".scn-row", 4); // coding · TDD + 2 subagents
await page.waitForSelector(".lab-step");
for (let i = 0; i < 500; i++) {
  const done = await page.evaluate(() => {
    const btn = document.querySelector(".lab-step");
    if (!btn || btn.disabled) return true;
    btn.click();
    return false;
  });
  if (done) break;
  await page.waitForTimeout(15);
}
await jsClickByText('.tab-nav [role="tab"]', "Trace");
await page.waitForTimeout(900);
await shoot("11-trace");

// ---------- 16-trace-resume-marker: resume a real archive, marker at the end ----------
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find(b => b.textContent.includes("What is 2+2"));
  if (!btn) throw new Error("no 2+2 archive in the sidebar");
  btn.click();
});
await page.waitForTimeout(600);
// The archive bar (with Resume) lives in the Chat tab.
await jsClickByText('.tab-nav [role="tab"]', "Chat");
await page.waitForTimeout(600);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find(b => /resume session/i.test(b.textContent));
  if (!btn) throw new Error("no resume button");
  btn.click();
});
await page.waitForTimeout(2500);
await jsClickByText('.tab-nav [role="tab"]', "Trace");
await page.waitForTimeout(800);
await page.evaluate(() => {
  const el = document.querySelector(".trace-scroll");
  if (el) el.scrollTop = el.scrollHeight;
});
await shoot("16-trace-resume-marker");

await browser.close();
console.log("done");
