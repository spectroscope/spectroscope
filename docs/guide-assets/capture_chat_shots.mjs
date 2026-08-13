// capture_chat_shots.mjs — the chat face after the 2026-07-26 rework.
//
// The canonical suite (capture_screens.mjs) photographs the whole app and is
// not re-shot lightly. This is its companion for one thing: the chat as it
// looks now, when the boxes came off. A user turn is a flat bubble on the
// right, an answer is bare text on the left, and a tool call is a hairline
// with a two-pixel rule rather than a card. Older plates show a chrome that
// no longer exists.
//
// Three deliberate choices, because a product frame is not a debug frame:
//
//   * The sidebar is collapsed in every shot. It is component state and NOT
//     persisted (App.tsx: useState(true)), so it has to be closed again after
//     every navigation — the selector is language-safe and the state is
//     asserted, never assumed.
//   * The tutorial is switched off over REST, so no level pill sits in the
//     header. These plates are about the chat, not about progression.
//   * The conversation is REAL and typed into the composer, so the session is
//     live and the composer is on screen. An imported or replayed session
//     shows the archive bar instead, which is a different picture.
//
// Usage (from docs/guide-assets/):
//   BASE_URL=http://localhost:8160 node capture_chat_shots.mjs
//   BASE_URL=http://localhost:8160 THEME=light node capture_chat_shots.mjs
//
// Wants: a server started on a pristine -Duser.home with SPECTRO_WORKSPACE
// pointing at the demo workspace, and ollama up. See capture_chat.sh.

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

// Same contract as the canonical suite; a plate that drifts here does not
// belong to the same set.
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
    // The first-run backend sheet has nothing to do with the chat.
    localStorage.setItem("spectroscope:onboarded", "1");
  } catch {}
}, [DESIGN]);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.split("\n")[0]));
const shots = [];

async function shoot(name, settle = 650) {
  await page.waitForTimeout(settle);
  await page.screenshot({ path: join(OUT, name + ".png") });
  shots.push(name);
  console.log("shot:", name);
}

/** Close the sidebar and PROVE it closed. Not persisted, so this runs after
 *  every navigation; the label is a toggle, so calling it twice re-opens it. */
async function hideSidebar() {
  const closed = () => page.evaluate(() =>
    document.querySelector(".layout")?.classList.contains("sidebar-closed") === true
    && document.querySelector(".sidebar") === null);
  if (await closed()) return;
  await page.evaluate(() =>
    document.querySelector('button[aria-label*="sidebar" i]')?.click());
  await page.waitForTimeout(350);
  if (!(await closed())) throw new Error("the sidebar did not collapse");
}

/** Toggle the agents/context panel. Language-safe: only these two labels
 *  contain "panel". */
async function panel(open) {
  const isOpen = () => page.evaluate(() => !!document.querySelector(".right-panel, .rp-root"));
  if ((await isOpen()) === open) return;
  await page.evaluate(() =>
    document.querySelector('button[aria-label*="panel" i], button[aria-label*="agents" i]')?.click());
  await page.waitForTimeout(400);
}

/** Type into the composer and wait for the run to finish.
 *
 *  The gate is ALLOWED, deliberately and by class name: `.gate-deny` is the
 *  first button in the bar, so anything that reaches for "the first button"
 *  denies the call and the plate ends up showing a refused command and a model
 *  apologising for it. `shotAtGate` photographs the bar first, because a run
 *  parked on a decision is one of the better frames this product has. */
async function say(text, { shotAtGate = null } = {}) {
  await page.locator(".composer-inner textarea").fill(text);
  // The send button lost its text and its classes on 2026-08-09: it is an icon
  // seat inside the rebuilt composer now. The aria-label is the stable handle.
  // Wait for the seat to BE the send seat: while a run is in flight the same
  // slot is the stop button, so a turn fired too early finds nothing at all.
  await page.locator('button[aria-label="Send"]').waitFor({ state: "visible", timeout: 240_000 });
  await page.locator('button[aria-label="Send"]').click();
  const deadline = Date.now() + 240_000;
  let sawGate = false;
  while (Date.now() < deadline) {
    if (await page.locator("button.gate-allow").count()) {
      if (!sawGate && shotAtGate) {
        await hideSidebar();
        await shoot(shotAtGate);
      }
      sawGate = true;
      await page.locator("button.gate-allow").first().click().catch(() => {});
      await page.waitForTimeout(500);
    }
    const busy = await page.evaluate(() =>
      // `.composer-stop` stopped existing on 2026-08-09 — the stop control is
      // the send seat wearing another modifier now. Without this the busy probe
      // was false the instant it was asked, so every turn was fired into a run
      // that had not finished.
      !!document.querySelector(".composer-seat--stop, .composer-stop, .caret.pulse, .thinking--active"));
    if (!busy) break;
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(1200);
  return sawGate;
}

/** Pick a row out of the disclosure popover by its label. */
async function disclosure(section, row) {
  await page.locator(".composer-inner button.icon-button.attach-button").first().click();
  await page.waitForSelector(".disc-pop", { timeout: 4000 });
  await page.evaluate(([sec, want]) => {
    const pop = document.querySelector(".disc-pop");
    const blocks = [...pop.querySelectorAll(".wsg-section")];
    const block = blocks.find((b) =>
      (b.querySelector(".wsg-section-head")?.textContent || "").toLowerCase().includes(sec));
    const target = [...(block ?? pop).querySelectorAll(".wsg-mode-row")].find((r) =>
      (r.textContent || "").toLowerCase().trim().startsWith(want));
    if (!target) throw new Error("no row " + want + " in " + sec);
    target.click();
  }, [section, row]);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(450);
}

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// The tutorial's intro owns the screen on a pristine home; take "open
// everything" so nothing is teased, then switch the tutorial off entirely so no
// pill sits in the header of a chat plate.
if (await page.locator(".lvl-intro").count()) {
  await page.locator(".lvl-intro__pick").last().click();
  await page.waitForTimeout(600);
}
await page.evaluate(() =>
  fetch("/api/leveling/mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "off" }),
  }));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await hideSidebar();

// ---- the conversation, typed for real ----
await panel(false);
console.log("turn 1 ...");
await say("What does this project do? Read the README first.");
console.log("turn 2 ...");
const gated = await say(
  "Now run: python3 run_checks.py — then tell me in one line whether the suite is green.",
  { shotAtGate: "44-chat-gate" });
if (!gated) throw new Error("no gate parked — the plate set needs one; is permissionMode still ask?");

await hideSidebar();
await panel(false);
await shoot("43-chat-answer");

// ---- everything open: thinking, and tool input/output ----
await disclosure("disclosure", "extended");
await hideSidebar();
await shoot("45-chat-extended");

// ---- one tool body up close: structured | json | raw, and the copy button ----
await page.evaluate(() => {
  const open = [...document.querySelectorAll(".tool-card")].reverse()
    .find((c) => c.querySelector(".tool-card-body.open"));
  (open ?? document.querySelector(".tool-card"))?.scrollIntoView({ block: "center" });
});
await shoot("46-chat-tool-open");

// ---- the wider reading measure ----
await disclosure("width", "wide");
await hideSidebar();
await shoot("47-chat-wide");
await disclosure("width", "normal");
await disclosure("disclosure", "normal");

// ---- the workspace beside the conversation ----
await panel(true);
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('button, [role="tab"]')]
    .find((b) => (b.textContent || "").trim() === "Files");
  tab?.click();
});
await hideSidebar();
await shoot("48-chat-files");
await panel(false);

// ---- the same run, read as a trace ----
await page.locator('.tab-nav button[role="tab"]').filter({ hasText: "trace" }).first().click();
await page.waitForTimeout(900);
await hideSidebar();
await shoot("49-chat-trace");

// ---- the extended text feed (new today) ----
await page.locator('.tab-nav button[role="tab"]').filter({ hasText: "text" }).first().click();
await page.waitForTimeout(700);
await page.evaluate(() => {
  const chip = [...document.querySelectorAll("button")]
    .find((b) => /extended/i.test(b.textContent || ""));
  chip?.click();
});
await hideSidebar();
await shoot("50-chat-text-extended");

console.log("DONE", shots.length, shots.join(", "));
await browser.close();
