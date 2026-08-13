// capture_screens.mjs — deterministic screenshot suite for USER-GUIDE.html
//
// Reproduce (once per theme):
//   1. start the backend from the demo workspace, against the CURATED home so
//      the left rail never prints a real session list (demo-home/README.md):
//        cd ~/spectro-demo
//        java -Duser.home=<repo>/spectro/docs/guide-assets/demo-home \
//             -jar /tmp/spectro-doc-080.jar --server.port=8090
//      (Ollama running for the live shots)
//   2. dark set:   node capture_screens.mjs                    -> shots/
//      light set:  THEME=light node capture_screens.mjs        -> shots-light/
//
//   Do NOT point this at the vite dev server on :8739. Its /api proxy targets
//   :8080, which reads the real ~/.spectro and puts 304 of the owner's own
//   sessions down the left rail of every frame. That is how the guide shipped
//   a working chat history in July.
//
// Every shot uses the EN chrome (localStorage spectroscope:lang=en) and the
// matching brand design, both seeded before load: spectro dark (espresso) or —
// with THEME=light — spectro bright (paper). All replay shots come from the
// built-in deterministic scenarios (no LLM); only the plan/thinking/gate shots
// do real local Ollama runs. The server's working directory IS the workspace
// every session shows (hence step 1: start it from ~/spectro-demo). The
// session-delete shot only ARMS the button (first click) and lets it
// auto-disarm — nothing is ever deleted.

import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const LIGHT = (process.env.THEME || "dark").toLowerCase() === "light";
const OUT = process.env.OUT_DIR || join(dirname(fileURLToPath(import.meta.url)), LIGHT ? "shots-light" : "shots");
const DESIGN = LIGHT ? "paper" : "spectroscope";      // spectro bright | spectro dark
// The design names were renamed: "spectro dark"/"spectro bright" became
// "spectro espresso"/"spectro paper" (there is also white and graphite).
// The old strings made the settings plate skip and left 19-design-white stale.
const DESIGN_NAME = LIGHT ? "spectro paper" : "spectro espresso";
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
const results = [];

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
async function shoot(name) {
  await page.waitForTimeout(550);
  await page.screenshot({ path: join(OUT, name + ".png") });
  results.push(name);
  console.log("shot:", name);
}
async function step(fn, label) {
  try { await fn(); } catch (e) { console.log("SKIP", label, "—", e.message.split("\n")[0]); }
}
// The Lab's step control. It was `button.lab-step` until 2026-07-22, when the
// transport was rebuilt into `.lab-ctrl-btns` with aria-labelled buttons. The
// old selector was left in this file and cost six plates for three weeks —
// silently, which is the part worth fixing. See stepLab() below.
const LAB_STEP = 'button[aria-label="Step forward"]';

/** One click of the Lab transport. Throws if the control is not there.
 *
 * The previous version of this returned "done" when the button was MISSING,
 * which is indistinguishable from "the dam is empty". So when the class name
 * changed, every lab plate quietly kept whatever PNG was already on disk and
 * the run still printed a clean log. A capture script that cannot tell "there
 * is nothing left to do" from "I cannot find the control" is worse than one
 * that crashes, because it launders a stale plate as a fresh one. */
async function stepLab() {
  const state = await page.evaluate((sel) => {
    const b = document.querySelector(sel);
    if (!b) return "missing";
    if (b.disabled) return "drained";
    b.click();
    return "stepped";
  }, LAB_STEP);
  if (state === "missing") throw new Error("lab transport not found: " + LAB_STEP);
  return state;
}

// step the Lab dam until empty (fast, no Flow timer)
async function drainLab(max = 500) {
  for (let i = 0; i < max; i++) {
    if (await stepLab() === "drained") return;
    await page.waitForTimeout(20);
  }
}
/** Pick a scenario from the modal. The picker grew a tab row ("chats / agents"
 * and "fleet"), so a bare .scn-row search only ever sees the active tab — which
 * is why "Coding" and "Review fan-out" stopped being found: both moved to the
 * fleet tab. Naming the tab is now part of naming the scenario.
 *
 * Entering a FLEET scenario replaces the app's six tabs with the fleet bar
 * (bus · spectrum · trace · one tab per node), so there is no Lab there. The
 * Lab plates must come from a chats/agents scenario. */
async function pickScenario(tab, name) {
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll(".scn-tab")].find(x => x.textContent.includes(t));
    if (!el) throw new Error("no scenario tab " + t);
    el.click();
  }, tab);
  await page.waitForTimeout(350);
  await jsClickByText(".scn-row", name);
}

const openRightPanel = async () => {
  const open = await page.evaluate(() => !!document.querySelector(".right-panel"));
  if (open) return;
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".icon-button")]
      .find(x => /agent/i.test(x.getAttribute("aria-label") || ""));
    if (!b) throw new Error("no panel toggle");
    b.click();
  });
  await page.waitForSelector(".right-panel");
};
const clickPanelTab = async (match) => {
  await page.evaluate((m) => {
    const t = [...document.querySelectorAll(".rp-tab")].find(x => new RegExp(m, "i").test(x.textContent));
    if (!t) throw new Error("no panel tab " + m);
    t.click();
  }, match);
};

// Default to the curated-home server (demo-home/README.md), NOT the dev server
// on :8739 whose proxy reaches the real ~/.spectro and prints a working chat
// history down the left rail of every plate.
const BASE = process.env.BASE_URL || "http://localhost:8090";
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

// ---------- 01 home ----------
await shoot("01-home-empty");

// ---------- 02 scenario picker ----------
await step(async () => {
  await jsClick(".sidebar-scenarios");
  await page.waitForSelector(".scn-modal");
  await shoot("02-scenario-picker");
}, "scenario picker");

// ---------- 03–04b the Lab on the "coding" scenario ----------
await step(async () => {
  // Was "Coding · 4 phases" until that scenario moved to the fleet tab, where
  // the fleet bar replaces the tab row and there is no Lab at all.
  await pickScenario("chats / agents", "build_plan · 1 subagent");
  await page.waitForTimeout(1200);
  await jsClickByText('.tab-nav [role="tab"]', "lab");   // the picker no longer lands on it
  await page.waitForSelector(LAB_STEP);
  await shoot("03-lab-flow-start");
  for (let i = 0; i < 10; i++) { await stepLab(); await page.waitForTimeout(200); }
  await shoot("04-lab-flow-mid");
  // a state with both subagent loops alive: step further
  for (let i = 0; i < 14; i++) { await stepLab(); await page.waitForTimeout(120); }
  await shoot("04b-lab-flow-subagents");
}, "lab flow");

// ---------- drain, then chat / graph / trace ----------
await step(async () => { await drainLab(); }, "drain scenario");

await step(async () => {
  await jsClickByText('.tab-nav [role="tab"]', "chat");
  await page.waitForTimeout(800);
  await shoot("07-chat-scenario-bottom");
  await page.evaluate(() => { const el = document.querySelector(".chat-scroll"); if (el) el.scrollTop = 0; });
  await shoot("08-chat-scenario-top");
  await page.evaluate(() => { const el = document.querySelector(".chat-scroll"); if (el) el.scrollTop = el.scrollHeight * 0.35; });
  await shoot("08b-chat-scenario-threads");
}, "chat scenario");

await step(async () => {
  await jsClickByText('.tab-nav [role="tab"]', "graph");
  await page.waitForTimeout(1600);
  await shoot("09-graph-flow-overview");
  await jsClickByText(".graph-viewbar .lab-grain-opt", "Graph");
  await page.waitForTimeout(1900);
  await shoot("10-graph-dagre");
  await jsClickByText(".graph-viewbar .lab-grain-opt", "Flow");
}, "graph tab");

await step(async () => {
  await jsClickByText('.tab-nav [role="tab"]', "trace");
  await page.waitForTimeout(900);
  await shoot("11-trace");
}, "trace tab");

// ---------- right panel: agents / context / files ----------
await step(async () => {
  await jsClickByText('.tab-nav [role="tab"]', "chat");
  await openRightPanel();
  await clickPanelTab("agent");
  await shoot("12-panel-agents");
  await clickPanelTab("context");
  await page.waitForTimeout(1200);
  await shoot("13-panel-system-context");
  await clickPanelTab("file");
  await page.waitForTimeout(1200);
  await shoot("14-panel-files");
}, "right panel");

// ---------- archive bar: resume + the two-step delete (ARM ONLY, never 2nd click) ----------
await step(async () => {
  // "build_plan" is a SCENARIO, not a stored session, and a scenario has no
  // archive bar — so this used to shoot a frame with no bar in it and file it
  // under 15-archive-bar. Open a real session from the curated home instead,
  // and refuse to shoot until the bar is actually on screen.
  await page.evaluate(() => {
    const seg = [...document.querySelectorAll("button")]
      .find(x => /^sessions$/i.test(x.textContent.trim()));
    if (seg) seg.click();
  });
  await page.waitForTimeout(500);
  await jsClickByText(".session-row", "auth refactor");
  await page.waitForSelector("button.archive-delete", { timeout: 10000 });
  await page.waitForTimeout(1200);
  await shoot("15-archive-bar");
  await page.evaluate(() => {
    // The archive bar's button reads just "Delete" — the old finder wanted
    // "really delete" or "delete session", which is the ARMED label, not the
    // resting one. Match the class instead of a word that only exists after
    // the click we are about to make.
    const del = document.querySelector("button.archive-delete");
    if (!del) throw new Error("no delete button (button.archive-delete)");
    del.click(); // ARMS only
  });
  await page.waitForTimeout(400);
  await shoot("15b-delete-armed");
  await page.waitForTimeout(4600); // auto-disarm, nothing deleted
}, "archive bar + delete arm");

// ---------- resume: the session_resume trace marker ----------
await step(async () => {
  await page.evaluate(() => {
    const btn = document.querySelector("button.resume-btn");
    if (!btn) throw new Error("no resume button (button.resume-btn)");
    btn.click();
  });
  await page.waitForTimeout(2500);
  await jsClickByText('.tab-nav [role="tab"]', "trace");
  await page.waitForTimeout(800);
  // scroll trace to bottom where the marker sits
  await page.evaluate(() => {
    const el = document.querySelector(".trace-list, .trace-view, .trace-scroll");
    if (el) el.scrollTop = el.scrollHeight;
  });
  await shoot("16-trace-resume-marker");
  await jsClickByText('.tab-nav [role="tab"]', "chat");
  await jsClick(".new-chat"); // detach again, no prompt was sent
  await page.waitForTimeout(600);
}, "resume marker");

// ---------- the review fan-out: spectrum lanes + the reasoning lens ----------
await step(async () => {
  await jsClick(".sidebar-scenarios");
  await page.waitForSelector(".scn-modal");
  await pickScenario("fleet", "Review fan-out");
  // A fleet scenario replaces the six app tabs with the fleet bar
  // (bus · spectrum · trace · one tab per node), so there is no Lab here and
  // nothing to drain: the replay is already complete on entry — measured at 46
  // trace rows the moment the view settles. Waiting for the Lab transport is
  // what made this block time out for three weeks and keep four July plates.
  await page.waitForSelector(".trace-row, .fleet-bar, [class*='fleetbar']", { timeout: 15000 });
  await page.waitForTimeout(900);
  // these two are the guide's big detail plates — collapse the sidebar
  await page.evaluate(() => document.querySelector('button[aria-label*="sidebar" i]')?.click());
  await page.waitForTimeout(300);
  await jsClickByText('.tab-nav [role="tab"]', "spectrum");
  await page.waitForTimeout(900);
  await shoot("20-spectrum-brand");
  await jsClickByText('.tab-nav [role="tab"]', "trace");
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    // lens ON for this shot (a persisted pref — the next run's seed resets it)
    const lens = [...document.querySelectorAll("button")].find(b => /reasoning lens/i.test(b.textContent));
    if (lens && lens.getAttribute("aria-pressed") !== "true") lens.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll(".trace-row")].find(r => r.textContent.includes("thinking"));
    if (!row) throw new Error("no thinking row");
    row.click();
    row.scrollIntoView({ block: "center" });
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(600);
  await shoot("21-trace-lens-brand");
  // Restore the normal stage. A fleet has no chat tab — its bar reads
  // bus · spectrum · trace · one per node — so the old cleanup threw here and
  // left every later block standing in the fleet.
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1100);
}, "review fan-out plates");

// ---------- provider picker ----------
await step(async () => {
  await page.evaluate(() => document.querySelector(".provider-chip").closest("button").click());
  await page.waitForTimeout(1200);
  await shoot("17-provider-picker");
  await page.keyboard.press("Escape");
}, "provider picker");

// ---------- settings page: the three designs ----------
await step(async () => {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".icon-button")]
      .find(x => /setting/i.test(x.getAttribute("aria-label") || ""));
    if (!b) throw new Error("no settings toggle");
    b.click();
  });
  await page.waitForSelector(".settings-page");
  await page.waitForTimeout(500);
  await shoot("18-design-drawer");
  await jsClickByText(".design-option", "spectro white");
  await page.waitForTimeout(900);
  await shoot("19-design-white");
  await jsClickByText(".design-option", DESIGN_NAME); // back to the run's design
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector(".settings-page .icon-button").click());
  await page.waitForTimeout(400);
}, "settings + white design");

// ---------- import dialog ----------
await step(async () => {
  // .sidebar-import is TWO different buttons: the Import button while the
  // sidebar is on Sessions (Sidebar.tsx:274) and the "spawn a node" button
  // while it is on Fleets (Sidebar.tsx:286, same class plus .sidebar-spawn).
  // The fan-out block above leaves the sidebar on Fleets, so this used to shoot
  // the spawn dialog and file it under the name 20-import-dialog — a plate that
  // is wrong rather than missing, which the generator cannot catch.
  await page.evaluate(() => {
    const seg = [...document.querySelectorAll("button")]
      .find(x => /^sessions$/i.test(x.textContent.trim()));
    if (seg) seg.click();
  });
  await page.waitForTimeout(500);
  await jsClick(".sidebar-import:not(.sidebar-spawn)");
  await page.waitForSelector(".import-modal, .modal", { timeout: 8000 });
  await page.waitForTimeout(1200);
  const looksRight = await page.evaluate(() =>
    /import|transcript/i.test(document.querySelector(".modal, .import-modal")?.textContent || ""));
  if (!looksRight) throw new Error("the open modal is not the import room");
  await shoot("20-import-dialog");
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const ghost = [...document.querySelectorAll(".modal .ghost, .modal-actions .ghost")].pop();
    if (ghost) ghost.click();
  });
  await page.waitForTimeout(400);
}, "import dialog");

// ---------- LIVE 1: update_plan → the Plan tab (local Ollama) ----------
/** Start a fresh live session. The three LIVE blocks below run against a real
 * backend, and every one of them used to inherit whatever the previous block
 * left on screen — after the import dialog that is an archived session in
 * read-only replay, which has no composer at all, so the send click found
 * nothing. Opening a new chat first is the whole fix. */
const newChat = async () => {
  // Whatever the previous block left open has to go first: a settings page or
  // an import modal sits over the composer, and clicking "New chat" behind it
  // does nothing a selector can see. Dismissing them one by one is a losing
  // game as the app grows dialogs, so reload instead — the seeded design and
  // language survive it because they live in localStorage.
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1100);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")]
      .find(x => /new chat/i.test(x.textContent) && x.offsetParent !== null);
    if (!b) throw new Error("no New chat button");
    b.click();
  });
  await page.waitForTimeout(900);
  const ok = await page.evaluate(() => !!document.querySelector('button[aria-label="Send"]'));
  if (!ok) throw new Error("composer did not open (a modal is probably still up)");
  await page.waitForTimeout(300);
};

const send = async (text) => {
  await page.evaluate((msg) => {
    const ta = document.querySelector(".chat textarea") || document.querySelector("textarea");
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    set.call(ta, msg);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  await page.waitForTimeout(300);
  await jsClick('button[aria-label="Send"]');   // was a text button until 2026-08-09
};
await step(async () => {
  await jsClick(".new-chat");
  await page.waitForTimeout(500);
  await newChat();
  await send("Call the update_plan tool exactly once with these three steps: step 1 'Read the project README' with status completed, step 2 'Summarize the build setup' with status in_progress, step 3 'Report back to the user' with status pending. After the tool call, just say: Plan published.");
  // wait for the plan to land in the Plan tab (badge appears)
  await openRightPanel();
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll(".rp-tab")].find(x => /plan/i.test(x.textContent));
    return t && /\d/.test(t.textContent);
  }, null, { timeout: 180000 });
  await clickPanelTab("plan");
  await page.waitForTimeout(600);
  await shoot("21-panel-plan-live");
}, "live plan run");

// ---------- LIVE 2: thinking + the gate bar (permission) ----------
await step(async () => {
  await jsClick(".new-chat");
  await page.waitForTimeout(500);
  await newChat();
  await send("Use the run_command tool to run exactly: pwd");
  await page.waitForSelector("[class*=thinking]", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await shoot("22-thinking-live");
  await page.waitForSelector(".gate-bar", { timeout: 180000 });
  await page.waitForTimeout(700);
  await shoot("23-permission-dialog");
  // 23b: tick "always allow" and expand for the full input + history
  await page.evaluate(() => {
    const cb = document.querySelector(".gate-remember input");
    if (cb && !cb.checked) cb.click();
    const ex = document.querySelector(".gate-expand");
    if (ex) ex.click();
  });
  await page.waitForTimeout(500);
  await shoot("23b-permission-dialog-remember");
  // 24: deny — no side effects
  await page.evaluate(() => {
    const cb = document.querySelector(".gate-remember input");
    if (cb && cb.checked) cb.click(); // un-tick so nothing is remembered
    document.querySelector(".gate-deny").click();
  });
  await page.waitForTimeout(2500);
  await shoot("24-after-deny");
}, "live gate run");

// ---------- LIVE 3: an allowed write lands in the Files tab ----------
await step(async () => {
  await jsClick(".new-chat");
  await page.waitForTimeout(500);
  await newChat();
  await send("Write a file hello.txt with the text hi. Use the write_file tool exactly once.");
  await page.waitForSelector(".gate-bar", { timeout: 180000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector(".gate-allow").click()); // writes hello.txt into the demo workspace
  // wait for the run to finish, then show the fresh file on the agent's desk
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll(".chat *")];
    return rows.some(el => /hello\.txt/.test(el.textContent) && el.closest("[class*=answer],[class*=assistant],[class*=msg]"));
  }, null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await openRightPanel();
  await clickPanelTab("file");
  // the tree loads on demand — refresh until the fresh file shows up
  for (let i = 0; i < 12; i++) {
    const there = await page.evaluate(() => /hello\.txt/.test(document.querySelector(".right-panel")?.textContent || ""));
    if (there) break;
    await page.evaluate(() => document.querySelector(".ws-refresh")?.click());
    await page.waitForTimeout(2500);
  }
  await page.waitForTimeout(600);
  await shoot("25-files-workspace");
}, "live write run");

console.log("DONE", results.length, results.join(", "));
await browser.close();
