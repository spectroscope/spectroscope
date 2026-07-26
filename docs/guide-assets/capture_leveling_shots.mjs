// The two ladder plates for the guide chapter (card 83).
//
// Its own script, like capture_fleet_shots.mjs, for one reason: the intro plate
// needs a home that has NEVER answered the ladder's first question, and that
// state cannot be restored over REST by design — a reset deliberately keeps the
// answer, because restarting the ladder is not re-onboarding. So the plate is
// shot against a server started on a pristine -Duser.home, and the panel plate
// is staged on top of it through the leveling endpoints.
//
// Usage:
//   BASE_URL=http://localhost:8115 node capture_leveling_shots.mjs
//   BASE_URL=http://localhost:8115 THEME=light node capture_leveling_shots.mjs
//
// The server must be freshly started on an empty home, e.g.
//   java -Duser.home=/tmp/fresh -jar spectro-server-<v>.jar --server.port=8115

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIGHT = (process.env.THEME || "dark").toLowerCase() === "light";
const OUT = join(HERE, LIGHT ? "shots-light" : "shots");
const BASE = process.env.BASE_URL || "http://localhost:8115";
mkdirSync(OUT, { recursive: true });

const DESIGN = LIGHT ? "paper" : "spectroscope";   // spectro bright | spectro dark
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1.5,
  locale: "en-US",
});
// Same keys the canonical suite uses, set before the app boots so the first
// paint is already in the right skin and language.
await ctx.addInitScript(([design]) => {
  try {
    localStorage.setItem("spectroscope:lang", "en");
    localStorage.setItem(
      "spectroscope:design",
      JSON.stringify({ design, scroll: true, particles: true, reasoningLens: false }),
    );
  } catch {}
}, [DESIGN]);
const page = await ctx.newPage();
const shots = [];
async function shoot(name) {
  await page.waitForTimeout(550);
  await page.screenshot({ path: join(OUT, name + ".png") });
  shots.push(name);
  console.log("shot:", name);
}

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

// plate 1: the one screen a never-used home opens with
const introUp = await page.evaluate(() => !!document.querySelector(".lvl-intro"));
if (!introUp) {
  console.error("no intro on screen — this home has already answered; start the server on a pristine -Duser.home");
  await browser.close();
  process.exit(1);
}
await shoot("33-leveling-intro");

// answer it, then stage a home that has climbed a little so the panel has ticks
await page.evaluate(() => document.querySelector(".lvl-intro__pick--primary")?.click());
await page.waitForTimeout(600);
await page.evaluate(async () => {
  const post = (path, body) =>
    fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (const surface of ["session", "replay", "disclosure", "permission-mode", "gate", "lens", "lab-step"]) {
    await post("/api/leveling/visit", { surface, sessionId: null });
  }
  await post("/api/leveling/visit", { surface: "spectrum", sessionId: "scenario:fanout", agentsShown: 4 });
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.evaluate(() => document.querySelector(".lvl-pill")?.click());
await page.waitForTimeout(700);
await shoot("34-leveling-panel");

console.log("DONE", shots.length, shots.join(", "));
await browser.close();
