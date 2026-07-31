// capture_0_3_0.mjs — the three NEW guide plates for 0.3.0, captured surgically
// into the SAME shots/ (or shots-light/) dir so the 33 existing shots are left
// untouched. Same seeding contract as capture_screens.mjs.
//
//   dark:   BASE_URL=http://localhost:8097 node capture_0_3_0.mjs
//   light:  THEME=light BASE_URL=http://localhost:8097 node capture_0_3_0.mjs
//
// Shots: 31-lab-expanded (deterministic scenario, no LLM), 30-text-explain
// (a real short reading off the ready provider), 32-settings-observability.

import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const LIGHT = (process.env.THEME || "dark").toLowerCase() === "light";
const OUT = process.env.OUT_DIR || join(dirname(fileURLToPath(import.meta.url)), LIGHT ? "shots-light" : "shots");
const DESIGN = LIGHT ? "paper" : "spectroscope";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1.5,
  colorScheme: LIGHT ? "light" : "dark",
});
await ctx.addInitScript(([design]) => {
  try {
    localStorage.setItem("spectroscope:lang", "en");
    localStorage.setItem("spectroscope:design",
      JSON.stringify({ design, scroll: true, particles: true, reasoningLens: false }));
  } catch {}
}, [DESIGN]);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.split("\n")[0]));

async function shoot(name) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, name + ".png") });
  console.log("shot:", name);
}
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
const STEP = 'button[aria-label="Step forward"]';
async function drainLab(max = 500) {
  for (let i = 0; i < max; i++) {
    const done = await page.evaluate((sel) => {
      const b = document.querySelector(sel);
      if (!b || b.disabled) return true;
      b.click();
      return false;
    }, STEP);
    if (done) return;
    await page.waitForTimeout(15);
  }
}

const BASE = process.env.BASE_URL || "http://localhost:8097";
const SCENARIO = "Bug hunt";   // "Bug hunt · 3 lenses as subagents" — rich enough that expanded spreads
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

// ---------- 31 lab expanded ----------
try {
  await jsClick(".sidebar-scenarios");
  await page.waitForSelector(".scn-modal");
  await jsClickByText(".scn-row", SCENARIO);
  await page.waitForSelector(".lab-transport");
  for (let i = 0; i < 24; i++) { await jsClick(STEP); await page.waitForTimeout(90); }
  // flip the view pill to expanded (button 1 of the compact|expanded segment)
  await jsClick(".lab-view-seg .lab-seg-btn", 1);
  await page.waitForTimeout(700);
  await shoot("31-lab-expanded");
} catch (e) { console.log("SKIP 31-lab-expanded —", e.message.split("\n")[0]); }

// ---------- 30 text explain (a real short reading; same loaded scenario) ----------
try {
  await drainLab();
  await jsClickByText('.tab-nav [role="tab"]', "text");
  await page.waitForTimeout(400);
  // the explain button in the text-tab toolbar (a .trace-lens whose title asks
  // a model to read the run); click it and wait for the streamed reading.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button.trace-lens")]
      .find(x => /read this run/i.test(x.getAttribute("title") || ""));
    if (!b) throw new Error("no explain button");
    b.click();
  });
  // wait for the panel to carry some streamed text (up to ~40s of inference)
  await page.waitForFunction(() => {
    const p = document.querySelector(".tf-explain");
    return p && p.textContent && p.textContent.replace(/\s/g, "").length > 240;
  }, { timeout: 45000 }).catch(() => console.log("  (explain stream short/absent — shooting anyway)"));
  await page.waitForTimeout(500);
  await shoot("30-text-explain");
} catch (e) { console.log("SKIP 30-text-explain —", e.message.split("\n")[0]); }

// ---------- 32 settings observability (clean reload first) ----------
try {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".icon-button")]
      .find(x => /settings/i.test(x.getAttribute("aria-label") || ""));
    if (!b) throw new Error("no settings gear");
    b.click();
  });
  await page.waitForTimeout(700);
  // Mask the real (local-dev) pk:sk so no credential value rides into a public
  // guide — display only, the stored setting is untouched. Then center the
  // Observability section.
  await page.evaluate(() => {
    for (const inp of document.querySelectorAll('input[type="text"]')) {
      if (/(?:pk|sk)[-_]/i.test(inp.value) && inp.value.includes(":")) {
        inp.value = "pk-lf-••••••••:sk-lf-••••••••";
      }
    }
    const label = [...document.querySelectorAll(".settings-label")]
      .find(x => /observ/i.test(x.textContent || ""));
    if (label) label.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(500);
  await shoot("32-settings-observability");
} catch (e) { console.log("SKIP 32-settings-observability —", e.message.split("\n")[0]); }

await browser.close();
console.log("done", LIGHT ? "(light)" : "(dark)");
