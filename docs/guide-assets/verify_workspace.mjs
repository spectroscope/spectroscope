// Live e2e for the agent workspace: prompt -> permission dialog -> approved ->
// add.py lands in the session's temp workspace -> the Files tab shows it.
// Real headless Chrome (rAF works, unlike the embedded pane).
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: "dark" });
await ctx.addInitScript(() => { try { localStorage.setItem("spectroscope:lang", "en"); } catch {} });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.split("\n")[0]));

await page.goto("http://localhost:8080", { waitUntil: "networkidle" });
await page.waitForTimeout(800);

// Type + send through the React composer.
await page.evaluate(() => {
  const ta = document.querySelector(".composer textarea");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, "Write a file add.py that prints 2+3, then run it with: python3 add.py");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(200);
await page.evaluate(() => {
  const send = [...document.querySelectorAll("button")].find(b => /^(Send|Senden)$/.test(b.textContent.trim()));
  send.click();
});

// Approve every permission question (write_file, then run_command) until the run ends.
let approvals = 0;
for (let i = 0; i < 180; i++) {
  await page.waitForTimeout(1000);
  const clicked = await page.evaluate(() => {
    const allow = [...document.querySelectorAll("button")]
      .find(b => /^(Allow|Erlauben)$/.test(b.textContent.trim()));
    if (allow) { allow.click(); return true; }
    return false;
  });
  if (clicked) { approvals++; console.log("approved question", approvals); }
  const done = await page.evaluate(() =>
    [...document.querySelectorAll("button")].some(b => /^(Send|Senden)$/.test(b.textContent.trim()))
    && document.querySelectorAll(".assistant-answer").length > 0);
  if (done && approvals >= 2) break;
}

const state = await page.evaluate(() => ({
  answer: [...document.querySelectorAll(".assistant-answer")].map(a => a.textContent).join(" | ").slice(0, 200),
  toolNames: [...document.querySelectorAll(".tool-card, [class*='tool']")].length,
}));
console.log("answer:", state.answer);

// Open the right panel -> Files tab; assert the session workspace chip + add.py.
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".icon-button")].find(b => /agent/i.test(b.title));
  btn?.click();
});
await page.waitForTimeout(400);
await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".rp-tab")].find(b => /(Files|Dateien)/.test(b.textContent));
  tab?.click();
});
await page.waitForTimeout(800);
const files = await page.evaluate(() => ({
  chip: document.querySelector(".ws-session-note")?.textContent ?? null,
  chipPath: document.querySelector(".ws-session-note")?.getAttribute("title") ?? null,
  root: document.querySelector(".ws-root")?.textContent ?? null,
  tree: [...document.querySelectorAll(".ws-tree [role=treeitem], .ws-tree button, .ws-tree span")]
    .map(e => e.textContent?.trim()).filter(Boolean).slice(0, 12),
}));
console.log("files-tab:", JSON.stringify(files));
await page.screenshot({ path: "shots-tmp-workspace-proof.png" });
await browser.close();
console.log("done");
