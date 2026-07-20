// capture_screens.mjs — deterministic screenshot suite for USER-GUIDE.html
//
// Reproduce (once per theme):
//   1. start the backend from the demo workspace:
//        cd ~/spectro-demo && java -jar .../spectro-server/build/libs/spectro-server-0.0.1.jar
//      (Ollama running for the live shots; any vite dev server or :8080 as BASE_URL)
//   2. dark set:   node capture_screens.mjs                    -> shots/
//      light set:  THEME=light node capture_screens.mjs        -> shots-light/
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
const DESIGN_NAME = LIGHT ? "spectro bright" : "spectro dark";
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
// step the Lab dam until empty (fast, no Flow timer)
async function drainLab(max = 500) {
  for (let i = 0; i < max; i++) {
    const done = await page.evaluate(() => {
      const b = document.querySelector(".lab-step");
      if (!b || b.disabled) return true;
      b.click();
      return false;
    });
    if (done) return;
    await page.waitForTimeout(20);
  }
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

const BASE = process.env.BASE_URL || "http://localhost:8739";
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
  await jsClickByText(".scn-row", "Coding"); // "Coding · 4 phases, parallel workers"
  await page.waitForSelector(".lab-step");
  await shoot("03-lab-flow-start");
  for (let i = 0; i < 10; i++) { await jsClick(".lab-step"); await page.waitForTimeout(200); }
  await shoot("04-lab-flow-mid");
  // a state with both subagent loops alive: step further
  for (let i = 0; i < 14; i++) { await jsClick(".lab-step"); await page.waitForTimeout(120); }
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
  await jsClickByText(".session-row", "build_plan");
  await page.waitForTimeout(1800);
  await shoot("15-archive-bar");
  await page.evaluate(() => {
    const del = [...document.querySelectorAll("button")].find(b => /really delete|delete session/i.test(b.textContent) || /delete/i.test(b.title || ""));
    if (!del) throw new Error("no delete button");
    del.click(); // ARMS only
  });
  await page.waitForTimeout(400);
  await shoot("15b-delete-armed");
  await page.waitForTimeout(4600); // auto-disarm, nothing deleted
}, "archive bar + delete arm");

// ---------- resume: the session_resume trace marker ----------
await step(async () => {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(b => /resume session/i.test(b.textContent));
    if (!btn) throw new Error("no resume button");
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
  await jsClickByText(".scn-row", "Review fan-out");
  await page.waitForSelector(".lab-step");
  await drainLab();
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
  // restore the normal stage: sidebar back, chat tab, a fresh live session
  await page.evaluate(() => document.querySelector('button[aria-label*="sidebar" i]')?.click());
  await page.waitForTimeout(300);
  await jsClickByText('.tab-nav [role="tab"]', "chat");
  await jsClick(".new-chat");
  await page.waitForTimeout(600);
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
  await jsClick(".sidebar-import");
  await page.waitForTimeout(1200);
  await shoot("20-import-dialog");
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const ghost = [...document.querySelectorAll(".modal .ghost, .modal-actions .ghost")].pop();
    if (ghost) ghost.click();
  });
  await page.waitForTimeout(400);
}, "import dialog");

// ---------- LIVE 1: update_plan → the Plan tab (local Ollama) ----------
const send = async (text) => {
  await page.evaluate((msg) => {
    const ta = document.querySelector(".chat textarea") || document.querySelector("textarea");
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    set.call(ta, msg);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  await page.waitForTimeout(300);
  await jsClickByText("button", "Send");
};
await step(async () => {
  await jsClick(".new-chat");
  await page.waitForTimeout(500);
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
