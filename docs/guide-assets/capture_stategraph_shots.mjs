// capture_stategraph_shots.mjs — the plates for the state-graph chapter (0.8.0).
//
// The state graph is the app's third top-level segment, so nothing in
// capture_screens.mjs reaches it: that suite drives session tabs. This one
// drives `nav === "stategraph"` and nothing else.
//
// Reproduce (once per theme), against the CURATED home so the left rail never
// prints a real session list — see demo-home/README.md:
//   cd ~/spectro-demo
//   java -Duser.home=<repo>/spectro/docs/guide-assets/demo-home \
//        -jar /tmp/spectro-doc-080.jar --server.port=8090
//   node capture_stategraph_shots.mjs                 -> shots/
//   THEME=light node capture_stategraph_shots.mjs     -> shots-light/
//
// No LLM, no key, no network: all five scenarios are bundled artefacts that
// the engine itself wrote in real runs. The footer says `offline · no network
// calls` in every frame, which is the point of shooting them.
//
// Four traps this file encodes, all measured on 2026-08-12:
//   - A fresh home has never dismissed the onboarding sheet. It covers every
//     frame until `got it` is clicked.
//   - There are TWO scenario pickers with DIFFERENT labels for the same runs:
//     the sidebar rail shows human titles ("CRAG · corrective loop"), the
//     empty pane's shelf shows bare file stems ("crag"). Never mix them.
//   - `instant` is not a speed. It jumps to the last record and pauses.
//   - A node card's ×N counts entries over the WHOLE run and is not scoped to
//     the cursor; the edge's ×N is. They can disagree on screen, on purpose.

import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const LIGHT = (process.env.THEME || "dark").toLowerCase() === "light";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT_DIR || join(HERE, LIGHT ? "shots-light" : "shots");
const DESIGN = LIGHT ? "paper" : "spectroscope";
const BASE = process.env.BASE_URL || "http://localhost:8090";
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

const shot = async (name, sel) => {
  await page.waitForTimeout(500);
  const target = sel ? page.locator(sel).first() : page;
  await target.screenshot({ path: join(OUT, name + ".png") });
  console.log("  shot:", name);
};
const step = async (fn, label) => {
  try { await fn(); } catch (e) { console.log("SKIP", label, "—", e.message.split("\n")[0]); }
};
/** Click a button by its exact trimmed text (the rail uses human titles). */
const clickText = (text) => page.evaluate((t) => {
  const b = [...document.querySelectorAll("button")]
    .find((x) => x.textContent.trim().startsWith(t) && x.offsetParent !== null);
  if (!b) throw new Error("no button starting " + t);
  b.click();
}, text);
const clickGlyph = (glyph) => page.evaluate((g) => {
  const b = [...document.querySelectorAll(".sg-transport button, .sg button")]
    .find((x) => x.textContent.trim() === g);
  if (!b) throw new Error("no transport glyph " + g);
  b.click();
}, glyph);

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

// The onboarding sheet: a fresh home has never seen it, and it covers
// everything. Shoot it once, then dismiss it for the rest of the run.
await step(async () => {
  await page.waitForSelector("text=welcome", { timeout: 4000 });
  await shot("59-sg-onboarding");
}, "onboarding plate");
await step(() => clickText("got it"), "dismiss onboarding");
await page.waitForTimeout(400);

// ---- 67: the sidebar segment. The ONE plate where the rail is the subject,
//      which is why the curated home exists at all.
await step(async () => {
  await clickText("State graph");
  await page.waitForTimeout(700);
  await shot("67-sg-sidebar-segment", ".sidebar, aside");
}, "sidebar segment");

// ---- 60: the empty pane. Note the shelf here says `crag`, not the rail's
//      "CRAG · corrective loop" — two pickers, two label sets.
await step(async () => {
  await page.waitForSelector(".sg--empty, .sg", { timeout: 5000 });
  await shot("60-sg-empty");
}, "empty pane");

// ---- 61: CRAG played to the end. The return arc rewrite→router is the whole
//      reason this project does not use dagre: dagre reverses it.
await step(async () => {
  await clickText("CRAG · corrective loop");
  await page.waitForSelector(".sg-transport", { timeout: 6000 });
  await clickGlyph(">|");
  await page.waitForTimeout(1200);
  await shot("61-sg-crag-complete");
}, "crag complete");

// ---- 62: the transport row, cropped, parked mid-run so the state chip does
//      not read "complete".
await step(async () => {
  await clickGlyph("|<");
  await page.waitForTimeout(300);
  for (let i = 0; i < 12; i++) { await clickGlyph(">"); await page.waitForTimeout(50); }
  await shot("62-sg-transport", ".sg-transport");
}, "transport row");

// ---- 63: a node picked mid-run, so the panel joins the values that node
//      wrote AT THIS VISIT rather than the run's last word.
await step(async () => {
  await page.evaluate(() => {
    const card = [...document.querySelectorAll(".sg-card")]
      .find((n) => /retrieve|grade/.test(n.textContent));
    if (!card) throw new Error("no retrieve/grade card");
    card.click();
  });
  await page.waitForTimeout(700);
  await shot("63-sg-panel-visit");
}, "panel on a visit");

// ---- 64: the failing run. A node error is shown with its class and message
//      rather than a shrug.
await step(async () => {
  await clickText("Failing run · an honest node_error");
  await page.waitForTimeout(900);
  await clickGlyph(">|");
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const card = [...document.querySelectorAll(".sg-card")]
      .find((n) => /generate/.test(n.textContent));
    if (!card) throw new Error("no generate card");
    card.click();
  });
  await page.waitForTimeout(700);
  await shot("64-sg-failed-node");
}, "failed node");

// ---- 66: the reference run records at tier `summary` with docs off the allow
//      list, so the panel says "not recorded" instead of implying emptiness.
await step(async () => {
  await clickText("Reference run · the measured template");
  await page.waitForTimeout(900);
  await clickGlyph(">|");
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const card = [...document.querySelectorAll(".sg-card")]
      .find((n) => /retrieve/.test(n.textContent));
    if (!card) throw new Error("no retrieve card");
    card.click();
  });
  await page.waitForTimeout(700);
  await shot("66-sg-not-recorded");
}, "not recorded");

// ---- 65: export. Two files, no options — the dialog is the whole feature.
await step(async () => {
  await clickText("export");
  await page.waitForSelector(".xd-modal, [class*='xd-']", { timeout: 4000 });
  await page.waitForTimeout(500);
  await shot("65-sg-export");
  await page.keyboard.press("Escape");
}, "export sheet");

console.log("done -> " + OUT);
await browser.close();
