// capture_commands_shot.mjs: the plate for the chat's commands (card 471).
//
// One frame: a new chat with "/" typed into the composer, so the picker shows
// /compact and /clear above the skills. No conversation is needed for it, and
// none is typed, so the plate shows no model's words and needs no model.
//
// Same contract as capture_chat_shots.mjs: 1600 x 1000 at 1.5, learn mode,
// English, the tutorial off, the sidebar collapsed.
//
// Usage (from docs/guide-assets/), against a server on a pristine
// -Duser.home, once per theme:
//   BASE_URL=http://localhost:8160 node capture_commands_shot.mjs
//   BASE_URL=http://localhost:8160 THEME=light node capture_commands_shot.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIGHT = (process.env.THEME || "dark").toLowerCase() === "light";
const OUT = join(HERE, LIGHT ? "shots-light" : "shots");
const BASE = process.env.BASE_URL || "http://localhost:8160";
const DESIGN = LIGHT ? "paper" : "spectroscope";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1.5,
  colorScheme: LIGHT ? "light" : "dark",
  locale: "en-US",
});
await ctx.addInitScript(([design]) => {
  try {
    localStorage.setItem("spectroscope:lang", "en");
    localStorage.setItem(
      "spectroscope:design",
      JSON.stringify({ design, scroll: true, particles: true, reasoningLens: false }),
    );
    localStorage.setItem("spectroscope:onboarded", "1");
    localStorage.setItem("spectroscope:mode", "learn");
    localStorage.setItem("spectroscope:mode-chosen", "1");
  } catch {}
}, [DESIGN]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));

await page.goto(BASE, { waitUntil: "networkidle" });
// The tutorial's intro owns the screen on a pristine home: open everything,
// then switch the tutorial off so no level pill sits in the header.
if (await page.locator(".lvl-intro").count()) {
  await page.locator(".lvl-intro__pick").last().click();
  await page.waitForTimeout(600);
}
await page.evaluate(() =>
  fetch("/api/leveling/mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "off" }),
  }),
);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

// The sidebar is component state and not persisted: close it and prove it.
const closed = () =>
  page.evaluate(
    () =>
      document.querySelector(".layout")?.classList.contains("sidebar-closed") === true &&
      document.querySelector(".sidebar") === null,
  );
if (!(await closed())) {
  await page.evaluate(() => document.querySelector('button[aria-label*="sidebar" i]')?.click());
  await page.waitForTimeout(350);
  if (!(await closed())) throw new Error("the sidebar did not collapse");
}

const field = page.locator(".composer-inner textarea");
await field.click();
await field.type("/");
await page.locator(".slash-pop").waitFor({ timeout: 5_000 });
const listed = await page.locator(".slash-pop .slash-name").allInnerTexts();
if (listed[0] !== "/compact" || listed[1] !== "/clear") {
  throw new Error(`the picker does not open with the two commands: ${JSON.stringify(listed)}`);
}
await page.waitForTimeout(650);
await page.screenshot({ path: join(OUT, "chat-commands-picker.png") });
console.log("shot:", join(LIGHT ? "shots-light" : "shots", "chat-commands-picker.png"));
if (errors.length > 0) {
  console.log("PAGEERROR:", errors.join(" | "));
  process.exitCode = 1;
}
await browser.close();
