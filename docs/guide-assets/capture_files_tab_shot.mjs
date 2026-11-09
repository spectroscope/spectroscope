// Captures the files tab for the guide (chapter 6, card 604): plate
// 72-files-tab, an edit_file call selected in the all view with its diff in the
// detail. House conventions as in capture_local_shots.mjs: 1600x1000 @1.5,
// en-US, design and mode seeded via localStorage BEFORE boot, THEME picks
// shots-light/ or shots/.
//
//   THEME=dark  BASE_URL=http://localhost:8791 node capture_files_tab_shot.mjs
//   THEME=light BASE_URL=http://localhost:8791 node capture_files_tab_shot.mjs
//
// The plate needs a session with real file activity, and none of the curated
// demo-home sessions edits a file. So the first pass makes one: a real run
// against the demo workspace, on a server started like this, from copies, so
// neither tracked folder is written:
//
//   cp -R demo-home/.spectro <home>/.spectro; cp -R demo-workspace/. <ws>/
//   <home>/.spectro/settings.json:
//     { "provider": "ollama", "model": "qwen2.5:7b", "workspace": "<ws>",
//       "thinking": false, "permissionMode": "auto" }
//   cd <ws> && java -Duser.home=<home> -jar <fresh jar> --server.port=8791
//
// Every later pass, the light one included, finds that session by its prompt
// and opens the same recording, so both designs show the same calls. A run
// that did not produce a successful edit_file exits 1 instead of shooting:
// start again from fresh copies.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THEME = process.env.THEME === "light" ? "light" : "dark";
const BASE_URL = process.env.BASE_URL ?? "http://localhost:8791";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.OUT_DIR ?? path.join(HERE, THEME === "light" ? "shots-light" : "shots");
const DESIGN = THEME === "light" ? "paper" : "spectroscope";
mkdirSync(OUT_DIR, { recursive: true });

// The file the run edits, and the messages that ask for it, one step each: a
// small local model follows one tool call per message far more reliably than a
// list of five. Relative paths only, so no folder of the capturing machine
// ends up in a call line on the plate.
const EDITED = "src/spectra/lines.py";
const HEAD = "Tighten the line tolerance in spectra to 0.25 nm.";
const TITLE = "Tighten the line tolerance";
const MESSAGES = [
  `${HEAD} First read README.md and then ${EDITED} with read_file, using exactly these relative paths. Do not change anything yet.`,
  [
    `Now call edit_file once on ${EDITED}. Set old_string to these two lines:`,
    "def identify(wavelength, tolerance=0.5):",
    '    """The reference line nearest `wavelength`, or None outside the tolerance."""',
    "Set new_string to these two lines:",
    "def identify(wavelength, tolerance=0.25):",
    '    """The reference line nearest `wavelength`, or None beyond `tolerance` nm."""',
  ].join("\n"),
  [
    "Now call write_file once to create tests/test_tolerance.py with exactly this content:",
    "from spectra import identify",
    "",
    "",
    "def test_identify_rejects_a_line_beyond_the_tolerance():",
    "    assert identify(656.6) is None",
  ].join("\n"),
  "Now call run_command once with the command: python3 run_checks.py. Then say in one sentence what changed.",
];

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1.5,
  locale: "en-US",
  colorScheme: THEME === "light" ? "light" : "dark",
});
await ctx.addInitScript(
  ([design]) => {
    try {
      localStorage.setItem("spectroscope:lang", "en");
      localStorage.setItem(
        "spectroscope:design",
        JSON.stringify({ design, scroll: true, particles: true, reasoningLens: false }),
      );
      // The files tab is a learn and developer surface; the mode question counts as answered.
      localStorage.setItem("spectroscope:mode", "learn");
      localStorage.setItem("spectroscope:mode-chosen", "2");
    } catch {
      // about:blank has no storage; the app's own pages do.
    }
  },
  [DESIGN],
);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.split("\n")[0]));

/** The stored session this plate is made from, or undefined. */
async function findSession() {
  const res = await fetch(`${BASE_URL}/api/sessions`);
  if (!res.ok) throw new Error(`GET /api/sessions answered ${res.status}`);
  const sessions = await res.json();
  return sessions.find((s) => typeof s.firstPrompt === "string" && s.firstPrompt.startsWith(HEAD));
}

const STOP = 'button[aria-label="Stop the running turn"]';

/** One message into the open chat, then wait until its run has ended. */
async function sendAndWait(text) {
  await page.waitForSelector('button[aria-label="Send"]', { timeout: 10000 });
  await page.evaluate((msg) => {
    const ta = document.querySelector(".chat textarea") || document.querySelector("textarea");
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    set.call(ta, msg);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  await page.waitForTimeout(300);
  await page.click('button[aria-label="Send"]');
  await page.waitForSelector(STOP, { timeout: 30000 });
  const until = Date.now() + 600000;
  while (Date.now() < until) {
    // A gate the permission mode did not settle is allowed: the run writes into a workspace copy.
    await page.evaluate(() => document.querySelector(".modal--gate .modal-actions .soft-primary")?.click());
    if ((await page.locator(STOP).count()) === 0) return;
    await page.waitForTimeout(1000);
  }
  throw new Error("a run did not end within ten minutes");
}

/** The messages in a new chat, one run each. */
async function runOnce() {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1100);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(
      (x) => /new chat/i.test(x.textContent) && x.offsetParent !== null,
    );
    if (!b) throw new Error("no New chat button");
    b.click();
  });
  for (const message of MESSAGES) {
    await sendAndWait(message);
    await page.waitForTimeout(1500);
  }
}

/** The recorded calls by name, with whether each result was an error. */
async function callsOf(id) {
  const res = await fetch(`${BASE_URL}/api/sessions/${encodeURIComponent(id)}/events`);
  if (!res.ok) throw new Error(`GET /api/sessions/${id}/events answered ${res.status}`);
  const body = await res.json();
  const events = Array.isArray(body) ? body : (body.events ?? []);
  const failed = new Set(events.filter((e) => e.type === "tool_result" && e.isError).map((e) => e.callId));
  return events
    .filter((e) => e.type === "tool_call")
    .map((e) => ({ name: e.name, path: e.input?.path ?? e.input?.command ?? "", failed: failed.has(e.callId) }));
}

let session = await findSession();
if (session === undefined) {
  console.log("no session for this plate yet: running the messages once");
  await runOnce();
  session = await findSession();
  if (session === undefined) throw new Error("the run left no stored session");
}
console.log(`session ${session.id}`);
// The rail row shows the title the model suggested, in whatever language it
// chose; the plate gets a fixed English one. It lands in session-meta.json of
// the throwaway home, never in the recording.
const renamed = await fetch(`${BASE_URL}/api/sessions/${encodeURIComponent(session.id)}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: TITLE }),
});
if (!renamed.ok) throw new Error(`PATCH /api/sessions/${session.id} answered ${renamed.status}`);
const calls = await callsOf(session.id);
console.log(calls.map((c) => `${c.name} ${c.path}${c.failed ? " (failed)" : ""}`).join("\n"));
if (!calls.some((c) => c.name === "edit_file" && c.path === EDITED && !c.failed)) {
  throw new Error(`no successful edit_file on ${EDITED} in ${session.id}: start again from fresh copies`);
}

// A fresh document for the route, so the address is read at boot and not as a hash change.
await page.goto("about:blank");
await page.goto(`${BASE_URL}/#/session/${encodeURIComponent(session.id)}/files`, { waitUntil: "networkidle" });
await page.waitForSelector(".files-tab .files-explorer", { timeout: 15000 });
// A level climb on opening shows a toast for seven seconds; the plate waits it out.
await page
  .waitForFunction(() => !document.body.innerText.includes("Level reached"), null, { timeout: 12000 })
  .catch(() => {});
await page.waitForTimeout(800);

// The edited file in the explorer: a press selects its latest change, which is the edit.
const row = page.locator(`.files-explorer .files-row[data-path$="${EDITED}"]`);
if ((await row.count()) === 0) throw new Error(`${EDITED} is not in the explorer`);
await row.first().click();
await page.waitForTimeout(500);
const detail = await page.evaluate(() => {
  const d = document.querySelector(".files-detail");
  return {
    tool: [...(d?.querySelectorAll(".files-detail__head .files-mono") ?? [])].map((s) => s.textContent).join(" "),
    diff: d?.querySelector(".files-diff") != null,
  };
});
if (!/edit_file/.test(detail.tool) || !detail.diff) {
  throw new Error(`the detail shows no edit with a diff: ${JSON.stringify(detail)}`);
}
// Let the fonts settle and keep the pointer off every hover state.
await page.mouse.move(1, 999);
await page.waitForTimeout(700);

await page.screenshot({ path: path.join(OUT_DIR, "72-files-tab.png") });
console.log(`72-files-tab.png -> ${OUT_DIR}`);

await browser.close();
