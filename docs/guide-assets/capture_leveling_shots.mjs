// The tutorial's plates for the guide chapter (cards 83, 84).
//
// Its own script, like capture_fleet_shots.mjs, for one reason: several of these
// states cannot be restored on a home that has already been used. The intro is
// asked once per home and a reset deliberately keeps the answer, because
// restarting the tutorial is not re-onboarding. So the plates are shot against
// servers started on pristine homes, and the rest is staged through the leveling
// endpoints rather than by clicking a path through the interface.
//
// TWO homes, because the dark frame is a real state and not a staged one.
// `provider-ready` has exactly one producer: /api/config marks it when some
// provider reports "ready". A local backend reporting "local" is deliberately
// not enough, so a home with ollama running but no key and no bundled model
// genuinely sits at the dark frame, while a home with the bundled model
// resolves to ready and has already left it before the first paint.
//
//   MODE=fresh   a home with no bundled model and nothing configured
//                -> the intro, the sheet that follows it, the empty strip
//   MODE=climb   a home with the bundled model and ollama configured
//                -> the teaser, the real level-up, the strip filling, the panel,
//                   the settings block
//
// Usage:
//   MODE=fresh BASE_URL=http://localhost:8151 node capture_leveling_shots.mjs
//   MODE=climb BASE_URL=http://localhost:8150 node capture_leveling_shots.mjs
//   ... each again with THEME=light
//
// The climb run wants a session with a real tool call in it, so that the panel's
// receipts point at something that happened. Run leveling_real_run.mjs against
// the same server first.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIGHT = (process.env.THEME || "dark").toLowerCase() === "light";
const OUT = join(HERE, LIGHT ? "shots-light" : "shots");
const MODE = (process.env.MODE || "climb").toLowerCase();
const BASE = process.env.BASE_URL || (MODE === "fresh" ? "http://localhost:8151" : "http://localhost:8150");
mkdirSync(OUT, { recursive: true });

const DESIGN = LIGHT ? "paper" : "spectroscope"; // spectro bright | spectro dark
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1.5,
  locale: "en-US",
  // The level-up flare is a real animation and this suite photographs it, so the
  // reduced-motion preference is explicitly off rather than left to the default.
  reducedMotion: "no-preference",
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

async function shoot(name, options = {}) {
  await page.waitForTimeout(options.settle ?? 550);
  await page.screenshot({ path: join(OUT, name + ".png"), ...(options.clip ? { clip: options.clip } : {}) });
  shots.push(name);
  console.log("shot:", name);
}

/** The pill alone, cropped. These three plates exist to be compared with each
 *  other, and the strip is about 90 pixels of a 1600-pixel window, so a
 *  full-window plate would be three near-identical screenshots of a screen.
 *  The tab row is deliberately NOT in frame: a closed tab looks exactly like an
 *  open one until you click it, so the tabs would carry no information here. */
async function shootStrip(name) {
  const box = await page.locator(".lvl-pill").boundingBox();
  if (!box) throw new Error("no .lvl-pill on screen");
  const pad = 26;
  await shoot(name, {
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
  });
}

/** Tabs carry badges (the trace shows an event count), so their accessible name
 *  is not just the label — match on the button's own text instead. */
function tab(label) {
  return page.locator('.tab-nav button[role="tab"]').filter({ hasText: label }).first();
}

async function levelState() {
  return page.evaluate(() => fetch("/api/leveling").then((r) => r.json()));
}

/** Marks criteria through the endpoint rather than by clicking a path through
 *  the interface. Deliberate: the interface refuses to report a surface it only
 *  teased, which is correct behaviour and makes a click-driven climb impossible
 *  from below. */
async function stage(visits) {
  await page.evaluate(async (surfaces) => {
    for (const visit of surfaces) {
      await fetch("/api/leveling/visit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(visit),
      });
    }
  }, visits);
}

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

if (MODE === "fresh") {
  // ---- plate 1: the one screen a never-used home opens with ----
  const introUp = await page.locator(".lvl-intro").count();
  if (!introUp) {
    console.error("no intro on screen — this home has already answered; start the server on a pristine -Duser.home");
    await browser.close();
    process.exit(1);
  }
  const before = await levelState();
  if (before.level !== 0) {
    console.error(`expected the dark frame, got level ${before.level} (${before.levelId}).`);
    console.error("a provider reporting ready leaves level 0 before the first paint — use a home with no bundled model.");
    await browser.close();
    process.exit(1);
  }
  await shoot("33-leveling-intro");

  // ---- plate 2: what comes NEXT, which is the point ----
  // The backend sheet is gated on the intro being answered, so the two welcome
  // screens are sequential and never stacked. That ordering is the feature: it
  // is the wall this wave exists to remove.
  await page.locator(".lvl-intro__pick--primary").click();
  await page.waitForSelector(".ob-panel", { timeout: 10_000 });
  await shoot("35-leveling-backend-next");

  // ---- plate 3: the empty strip, with the tutorial still shut ----
  await page.locator(".km-close").first().click();
  await page.waitForTimeout(500);
  await shootStrip("37-leveling-strip-dark");
} else {
  // The climb home has answered nothing yet either; take the tutorial.
  if (await page.locator(".lvl-intro").count()) {
    await page.locator(".lvl-intro__pick--primary").click();
    await page.waitForTimeout(700);
  }
  if (await page.locator(".ob-panel").count()) {
    await page.locator(".km-close").first().click();
    await page.waitForTimeout(400);
  }

  const start = await levelState();
  if (start.level !== 1) {
    console.error(`expected first light, got level ${start.level} (${start.levelId}) — run leveling_real_run.mjs first`);
    await browser.close();
    process.exit(1);
  }

  // ---- plate 4: a locked surface, which is a teaser and never a hidden tab ----
  await tab("trace").click();
  await page.waitForSelector(".lvl-teaser", { timeout: 5_000 });
  await shoot("36-leveling-teaser");

  // ---- plate 5: the level-up, earned rather than staged ----
  // Freeze the ignite at its peak frame instead of racing a 0.55s animation with
  // a screenshot. The animation is the real one; a negative delay on a paused,
  // stretched copy simply holds it still at 60%, where the new line is brightest.
  await page.addStyleTag({
    content: `.lvl-slot--new::after {
      animation-name: lvl-ignite !important;
      animation-duration: 6s !important;
      animation-timing-function: linear !important;
      animation-delay: -3.6s !important;
      animation-play-state: paused !important;
      animation-fill-mode: both !important;
    }`,
  });
  await tab("chat").click();
  await page.waitForTimeout(400);
  // Opening the finished run reports the session surface, which is the last
  // criterion first light is waiting on. The climb to the trace is genuine.
  await page.locator(".session-row:not(.live-row)").first().click();
  await page.waitForSelector(".lvl-toast", { timeout: 10_000 });
  await shoot("40-leveling-levelup", { settle: 350 });

  const climbed = await levelState();
  if (climbed.level !== 2) {
    console.error(`expected the trace after the climb, got level ${climbed.level}`);
    await browser.close();
    process.exit(1);
  }

  // ---- plate 6: two lines on the strip ----
  await page.waitForTimeout(7000); // let the toast retire so it is not in the crop
  await shootStrip("38-leveling-strip-trace");

  // ---- plate 7: the panel, with a receipt that resolves ----
  await page.locator(".lvl-pill").click();
  await page.waitForSelector(".lvl-drawer", { timeout: 5_000 });
  await shoot("34-leveling-panel");
  await page.keyboard.press("Escape");
  await page.locator(".lvl-drawer-scrim").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.waitForTimeout(400);

  // ---- plate 8: the whole spectrum ----
  // The trace is a JOINED criterion: a look alone never marks it, the session's
  // own stream has to agree that there was a tool call to look at. So this one
  // visit carries the real session, and the others do not need to.
  const traced = await page.evaluate(async () => {
    const list = await fetch("/api/sessions").then((r) => r.json());
    return Array.isArray(list) && list.length ? list[0].id : null;
  });
  if (!traced) throw new Error("no stored session — run leveling_real_run.mjs first");
  await stage([
    { surface: "replay", sessionId: null },
    { surface: "disclosure", sessionId: null },
    { surface: "trace", sessionId: traced },
    { surface: "permission-mode", sessionId: null },
    { surface: "gate", sessionId: null },
    { surface: "lens", sessionId: null },
    { surface: "lab-step", sessionId: null },
    { surface: "spectrum", sessionId: null, agentsShown: 4 },
    { surface: "fleet", sessionId: null },
    { surface: "machine-room", sessionId: null },
  ]);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const top = await levelState();
  if (top.level !== 6) {
    console.error(`expected deep field, got level ${top.level} (${top.levelId})`);
    await browser.close();
    process.exit(1);
  }
  await shootStrip("39-leveling-strip-deep");

  // ---- plate 9: the way out ----
  await page.locator('button[aria-label="Settings"]').first().click();
  await page.waitForSelector(".settings-page", { timeout: 5_000 });
  // The block only renders once the tutorial snapshot has arrived, so wait for it
  // rather than racing the fetch.
  await page
    .locator(".settings-page .settings-label", { hasText: /^Tutorial$/ })
    .first()
    .waitFor({ state: "attached", timeout: 10_000 });
  // Scroll the panel's own scroll container rather than asking the label to
  // bring itself into view: the settings page is a scroll box inside a fixed
  // scrim, and scrollIntoView on a descendant of that resolves against the
  // wrong box and quietly does nothing.
  const scrolled = await page.evaluate(() => {
    const label = [...document.querySelectorAll(".settings-page .settings-label")].find((el) =>
      /^\s*tutorial\s*$/i.test(el.textContent || ""),
    );
    if (!label) return false;
    const box = label.closest(".settings-body") ?? label.parentElement;
    if (!box) return false;
    box.scrollTop = label.offsetTop - box.offsetTop - 40;
    return true;
  });
  if (!scrolled) throw new Error("no leveling block in the settings page");
  await page.waitForTimeout(400);
  // Prove it is actually on screen before spending a plate on it.
  const onScreen = await page.evaluate(() => {
    const label = [...document.querySelectorAll(".settings-page .settings-label")].find((el) =>
      /^\s*tutorial\s*$/i.test(el.textContent || ""),
    );
    const rect = label?.getBoundingClientRect();
    return !!rect && rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  if (!onScreen) throw new Error("the leveling settings block did not scroll into view");
  await shoot("41-leveling-settings");
}

console.log("DONE", shots.length, shots.join(", "));
await browser.close();
