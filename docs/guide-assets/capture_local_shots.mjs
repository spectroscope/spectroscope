// Captures the built-in model chooser for the guide (chapter 16b), following
// the house conventions (capture_0_3_0.mjs / capture_leveling_shots.mjs):
// 1600x1000 @1.5, en-US, design seeded via localStorage BEFORE boot, THEME
// picks shots-light/ vs shots/. The shot walks the real first-run tutorial
// path — ladder intro, backend sheet, "Choose a model …" — so it needs a
// server on a FRESH -Duser.home (the intro appears once per home).
//
//   THEME=dark  BASE_URL=http://localhost:8157 node capture_local_shots.mjs
//   THEME=light BASE_URL=http://localhost:8158 node capture_local_shots.mjs

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THEME = process.env.THEME === "light" ? "light" : "dark";
const BASE_URL = process.env.BASE_URL ?? "http://localhost:8157";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.OUT_DIR ?? path.join(HERE, THEME === "light" ? "shots-light" : "shots");
const DESIGN = THEME === "light" ? "paper" : "spectroscope";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1.5,
  locale: "en-US",
  colorScheme: THEME === "light" ? "light" : "dark",
});
await ctx.addInitScript(
  ([design]) => {
    localStorage.setItem("spectroscope:lang", "en");
    localStorage.setItem(
      "spectroscope:design",
      JSON.stringify({ design, scroll: true, particles: true, reasoningLens: false }),
    );
  },
  [DESIGN],
);

const page = await ctx.newPage();
await page.goto(BASE_URL, { waitUntil: "networkidle" });

// The fresh-home gate: without the ladder intro this home is used and the
// tutorial path cannot be photographed — same discipline as the leveling suite.
const intro = page.locator(".lvl-intro");
if ((await intro.count()) === 0) {
  console.error("no ladder intro on screen — start the server on a pristine -Duser.home");
  process.exit(1);
}
await page.getByRole("button", { name: /start with the ladder/i }).click();

// The backend sheet follows, with the built-in path first; into the chooser.
await page.locator(".ob-opt-cta").first().waitFor({ timeout: 5000 });
await page.locator(".ob-opt-cta").first().click();
await page.locator(".lm-modal .lm-row").first().waitFor({ timeout: 5000 });
// Let the catalogue rows settle (one fetch fills them) and the fonts land.
await page.waitForTimeout(600);

await page.screenshot({ path: path.join(OUT_DIR, "42-local-chooser.png") });
console.log(`42-local-chooser.png -> ${OUT_DIR}`);

await browser.close();
