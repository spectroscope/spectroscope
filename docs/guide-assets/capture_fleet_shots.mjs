// capture_fleet_shots.mjs — the fleet plates for USER-GUIDE.html (card 37).
//
// Focused sibling of capture_screens.mjs: same chrome (EN, seeded brand
// design, 1600x1000 @1.5x), but it shoots ONLY the fleet family:
//
//   26-fleet-home          entered fleet: sidebar row + the fleet home
//   27-fleet-canvas        the spectral-DAG canvas (graph tab)
//   28-fleet-machine-room  the machine room (lab tab), scrubbed mid-flight
//   29-fleet-gate          a REAL parked gate answered from the gate bar
//
// Reproduce (once per theme):
//   1. hub-enabled server:  SPECTRO_HUB_PORT=7614 SPECTRO_ALLOW_SPAWN=true \
//        ./gradlew :spectro-server:bootRun --args='--server.port=8091'
//   2. for shot 29 ONLY, park a real gate first (own terminal):
//        ./gradlew :spectro-cli:run --args="node -p 'Create demo.txt … ' \
//          --hub 127.0.0.1:7614 --context pr-42-review --permissions ask"
//      (the script finds the fleet by its pending-gate row; without one the
//      shot is skipped, never faked)
//   3. dark:  BASE_URL=http://localhost:8091 node capture_fleet_shots.mjs
//      light: THEME=light BASE_URL=http://localhost:8091 node capture_fleet_shots.mjs
//
// Shots 26-28 ride the built-in fleet-swarm SCENARIO — deterministic, no LLM.
// Shot 29 is genuinely live (ask-mode node parked at its gate); the script
// only PHOTOGRAPHS the parked state and then denies, so nothing is written.

import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const LIGHT = (process.env.THEME || "dark").toLowerCase() === "light";
const OUT =
  process.env.OUT_DIR ||
  join(dirname(fileURLToPath(import.meta.url)), LIGHT ? "shots-light" : "shots");
const DESIGN = LIGHT ? "paper" : "spectroscope";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1.5,
  colorScheme: LIGHT ? "light" : "dark",
});
await ctx.addInitScript(
  ([design]) => {
    try {
      localStorage.setItem("spectroscope:lang", "en");
      localStorage.setItem(
        "spectroscope:design",
        JSON.stringify({ design, scroll: true, particles: true, reasoningLens: false, timelineLens: true }),
      );
    } catch {}
  },
  [DESIGN],
);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.split("\n")[0]));

async function shoot(name) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, name + ".png") });
  console.log("shot:", name);
}
async function step(fn, label) {
  try {
    await fn();
  } catch (e) {
    console.log("SKIP", label, "—", e.message.split("\n")[0]);
  }
}
const clickByText = (sel, text) =>
  page.evaluate(
    ([s, t]) => {
      const el = [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t));
      if (!el) throw new Error("no " + s + " containing " + t);
      el.click();
    },
    [sel, text],
  );

const BASE = process.env.BASE_URL || "http://localhost:8091";
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

// ---- load the fleet-swarm scenario (deterministic, enters the fleet) -------
await step(async () => {
  await clickByText("button", "Scenarios");
  await page.waitForSelector(".modal, [role=dialog]", { timeout: 4000 }).catch(() => {});
  await clickByText("[role=tab], button", "fleet");
  await page.waitForTimeout(300);
  await clickByText("button", "Fleet swarm");
  await page.waitForTimeout(800);
}, "load fleet-swarm scenario");

// 26 — the fleet home (chat tab of an entered fleet: getting started + spawn)
await step(async () => {
  await clickByText(".tab", "chat");
  await page.waitForTimeout(400);
  await shoot("26-fleet-home");
}, "26-fleet-home");

// 27 — the spectral-DAG canvas (graph tab); sidebar hidden — the plate is the map
await step(async () => {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".icon-button, button")].find((x) =>
      /hide sidebar/i.test(x.getAttribute("aria-label") || x.title || ""),
    );
    if (b) b.click();
  });
  await clickByText(".tab", "graph");
  await page.waitForSelector(".fleet-canvas", { timeout: 4000 });
  await page.waitForTimeout(900); // dagre layout + fitView settle
  await shoot("27-fleet-canvas");
}, "27-fleet-canvas");

// 28 — the machine room (lab tab), scrubbed to ~62% so rails are lit
await step(async () => {
  await clickByText(".tab", "lab");
  await page.waitForSelector(".lab-flowmap", { timeout: 4000 });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const slider = document.querySelector(".lab-scrub input[type=range]");
    if (!slider) throw new Error("no fleet transport slider");
    const max = Number(slider.max);
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    nativeSetter.call(slider, String(Math.floor(max * 0.62)));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(500);
  await shoot("28-fleet-machine-room");
}, "28-fleet-machine-room");

// 29 — a real parked gate (only when an ask-mode node is genuinely parked)
await step(async () => {
  // back to the sidebar's fleet list; a fleet with a parked gate floats up
  await page.evaluate(() => {
    const seg = [...document.querySelectorAll(".sidebar-seg-btn")].find((b) =>
      /fleet/i.test(b.textContent),
    );
    if (!seg) throw new Error("no fleets segment");
    seg.click();
  });
  await page.waitForTimeout(600);
  const entered = await page.evaluate(() => {
    // the row with the pulsing gate chip IS the parked fleet — never guess
    const rows = [...document.querySelectorAll(".fleet-row")];
    const parked = rows.find((r) => r.querySelector(".fleet-gate-chip"));
    if (!parked) return false;
    parked.click();
    return true;
  });
  if (!entered) throw new Error("no live fleet with a parked gate — shot skipped");
  await page.waitForTimeout(700);
  await clickByText(".tab", "spectrum");
  await page.waitForSelector(".gate-bar", { timeout: 6000 });
  await shoot("29-fleet-gate");
  // deny the parked call so the demo node never writes anything
  await page.evaluate(() => {
    const deny = [...document.querySelectorAll(".gate-bar button")].find((b) =>
      /deny/i.test(b.textContent),
    );
    if (deny) deny.click();
  });
}, "29-fleet-gate");

await browser.close();
console.log("done ->", OUT);
