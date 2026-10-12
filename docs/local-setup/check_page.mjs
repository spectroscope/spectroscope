// Browser check of the Local Setup page (card 529), against the installed
// Chrome channel, as the house rules ask for anything that measures layout.
//
//   PAGE_URL=file:///…/index.html SCRIPTS_DIR=…/scripts OUT_DIR=… node check_page.mjs
//
// PAGE_URL is the page in its served layout: index.html with scripts/ beside
// it, the way the website, the jar and ~/.spectro place it. The tracked
// docs/local-setup/index.html has that layout, and the Python test
// BrowserCheck runs this file against it where Chrome is installed. The check writes
// screenshots and result.json into OUT_DIR and exits 1 on the first broken
// expectation, after writing what it measured.

import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PAGE_URL = process.env.PAGE_URL;
const SCRIPTS_DIR = process.env.SCRIPTS_DIR;
const OUT_DIR = process.env.OUT_DIR;
const LABEL = process.env.LABEL || "page";
if (!PAGE_URL || !SCRIPTS_DIR || !OUT_DIR) {
  console.error("set PAGE_URL, SCRIPTS_DIR and OUT_DIR");
  process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });

const result = { label: LABEL, url: PAGE_URL, checks: [], consoleErrors: [], foreignRequests: [] };
let failed = false;
function check(name, ok, detail) {
  result.checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) failed = true;
}
function scriptBody(name) {
  const text = readFileSync(join(SCRIPTS_DIR, name), "utf8");
  return text.slice(text.indexOf("\n\n") + 2);
}

const pageOrigin = new URL(PAGE_URL);
const browser = await chromium.launch({ channel: "chrome", headless: true });

async function open(width, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: "en-US" });
  if (pageOrigin.protocol.startsWith("http")) {
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: pageOrigin.origin });
  } else {
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  }
  if (opts.blockStorage) {
    await ctx.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() { throw new DOMException("blocked for the check", "SecurityError"); },
      });
    });
  }
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") result.consoleErrors.push(`${width}: ${m.text()}`); });
  page.on("pageerror", (e) => result.consoleErrors.push(`${width}: pageerror ${e.message}`));
  page.on("request", (r) => {
    const u = r.url();
    const same = u === PAGE_URL || u.split("#")[0] === PAGE_URL.split("#")[0];
    if (!same && !u.startsWith("data:")) result.foreignRequests.push(u);
  });
  await page.goto(PAGE_URL, { waitUntil: "load" });
  return { ctx, page };
}

async function toDesign(page, id) {
  for (let i = 0; i < 4; i++) {
    if ((await page.evaluate(() => document.documentElement.dataset.design)) === id) return true;
    await page.click("#design");
  }
  return (await page.evaluate(() => document.documentElement.dataset.design)) === id;
}

// 1. all four designs at both widths, through the design switch
for (const width of [1280, 390]) {
  for (const design of ["spectroscope", "paper", "still", "graphite"]) {
    const { ctx, page } = await open(width);
    check(`design switch reaches ${design} at ${width}`, await toDesign(page, design));
    const m = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      bg: getComputedStyle(document.body).backgroundColor,
      shotDark: [...document.querySelectorAll("#level-1 img.shot-dark")].filter((i) => i.offsetParent !== null).length,
      shotLight: [...document.querySelectorAll("#level-1 img.shot-light")].filter((i) => i.offsetParent !== null).length,
    }));
    check(`no horizontal scroll, ${design} ${width}`, m.scrollWidth <= m.innerWidth, m);
    const wantDark = design === "spectroscope" || design === "graphite";
    check(`one plate set visible, ${design} ${width}`, wantDark ? m.shotDark === 1 && m.shotLight === 0 : m.shotDark === 0 && m.shotLight === 1, m);
    await page.screenshot({ path: join(OUT_DIR, `${LABEL}-${design}-${width}.png`), fullPage: true });
    // level 2 as well, the one with the most cards
    await page.click("#tab-2");
    await page.screenshot({ path: join(OUT_DIR, `${LABEL}-${design}-${width}-level2.png`), fullPage: true });
    const m2 = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check(`no horizontal scroll on level 2, ${design} ${width}`, m2);
    await ctx.close();
  }
}

// 2. the card's scenario, plus the keys, the platform switch and the copy
{
  const { ctx, page } = await open(1280);
  await page.click('[data-set-platform="mac"]');
  await page.click("#tab-2");
  const cards = await page.evaluate(() => [...document.querySelectorAll(".card")]
    .filter((c) => c.offsetParent !== null).map((c) => c.id));
  check("level 2 shows four cards, the built-in model first", cards.length === 4 && cards[0] === "step-2.1", cards);

  // arrow keys, both directions
  await page.focus("#tab-2");
  await page.keyboard.press("ArrowRight");
  const right = await page.evaluate(() => document.querySelector('.tl-level[aria-selected="true"]').dataset.level);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  const left = await page.evaluate(() => document.querySelector('.tl-level[aria-selected="true"]').dataset.level);
  check("arrow keys move the level right and left", right === "3" && left === "1", { right, left });
  const jdk = await page.evaluate(() => document.getElementById("step-1.2").innerText);
  check("the JDK card says it is not needed for the DMG", /not needed for/i.test(jdk) && jdk.includes("DMG"), jdk.slice(0, 400));
  await page.click("#tab-2");

  // copy "ollama pull qwen2.5:7b" and read the clipboard back
  const btn = page.locator("#step-2\\.2 [data-platform=mac] .cmdbox", { hasText: "ollama pull qwen2.5:7b" }).locator("button.copy");
  await btn.click();
  let clip = null;
  try { clip = await page.evaluate(() => navigator.clipboard.readText()); } catch (e) { clip = `read failed: ${e.message}`; }
  const body = scriptBody("mac-step-2-2.sh");
  check("copy yields exactly the line", clip === "ollama pull qwen2.5:7b", JSON.stringify(clip));
  check("the line is a line of mac-step-2-2.sh", body.split("\n").includes(clip), body);

  // the apt block is the whole body of linux-step-1-1.sh: byte for byte
  await page.click('[data-set-platform="linux"]');
  await page.click("#tab-1");
  await page.locator("#step-1\\.1 [data-platform=linux] button.copy").first().click();
  let apt = null;
  try { apt = await page.evaluate(() => navigator.clipboard.readText()); } catch (e) { apt = `read failed: ${e.message}`; }
  const aptBody = scriptBody("linux-step-1-1.sh");
  check("the apt copy equals linux-step-1-1.sh byte for byte", Buffer.from(apt + "\n").equals(Buffer.from(aptBody)),
    { clipBytes: Buffer.byteLength(apt), bodyBytes: Buffer.byteLength(aptBody) });

  // platform switch
  await page.click("#tab-2");
  const lm = await page.evaluate(() => {
    const c = document.getElementById("step-2.3");
    const vis = (sel) => [...c.querySelectorAll(sel)].filter((e) => e.offsetParent !== null).length;
    return { linuxNote: vis('[data-platform="linux"] .none'), macBlocks: vis('[data-platform="mac"]') };
  });
  check("Linux shows the not covered line on LM Studio and hides the macOS blocks", lm.linuxNote === 1 && lm.macBlocks === 0, lm);
  const lmCheck = await page.evaluate(() => [...document.querySelectorAll("#step-2\\.3 .check, #step-2\\.3 .copy-check")]
    .filter((e) => e.offsetParent !== null).length);
  check("on Linux LM Studio shows no check", lmCheck === 0, { visible: lmCheck });
  const dmgOn = () => page.evaluate(() => [...document.querySelectorAll(".card .size")]
    .filter((e) => e.offsetParent !== null && e.textContent.includes(".dmg")).map((e) => e.closest(".card").id));
  const dmgLinux = [];
  for (const level of [2, 4]) {
    await page.click(`#tab-${level}`);
    dmgLinux.push(...(await dmgOn()));
  }
  check("on Linux no .dmg size shows", dmgLinux.length === 0, dmgLinux);
  await page.click("#tab-2");
  const needsOn = () => page.evaluate(() => [...document.querySelectorAll(".needs [data-platform]")]
    .filter((e) => e.offsetParent !== null).map((e) => e.parentElement.id + ":" + e.dataset.platform));
  const linuxNeeds = await needsOn();
  check("on Linux the header names git, Docker's apt repository, cmake and Ollama and not Homebrew",
    linuxNeeds.join() === "needs-git:linux,needs-docker-repo:linux,needs-build-tools:linux,needs-ollama:linux", linuxNeeds);
  await page.click('[data-set-platform="mac"]');
  const macNeeds = await needsOn();
  check("on macOS the header names Homebrew and git", macNeeds.join() === "needs-homebrew:mac,needs-git:mac", macNeeds);
  await page.click("#tab-2");
  const dmgMac = await dmgOn();
  check("on macOS the Ollama.dmg size shows", dmgMac.includes("step-2.2"), dmgMac);
  await page.locator("#step-2\\.2 [data-platform=mac] .cmdbox", { hasText: "brew install ollama" })
    .locator(".cmd-need a").click();
  const hop = await page.evaluate(() => {
    const r = document.getElementById("needs-homebrew").getBoundingClientRect();
    return { hash: location.hash, top: Math.round(r.top), text: document.getElementById("needs-homebrew").innerText.slice(0, 60) };
  });
  check("the needs Homebrew mark leads to the Homebrew note", hop.hash === "#needs-homebrew" && hop.top >= 0 && hop.top < 900, hop);
  await page.screenshot({ path: join(OUT_DIR, `${LABEL}-needs-homebrew.png`) });

  // the mark survives a reload
  await page.click("#tab-2");
  await page.check('input[data-mark="2.2"]');
  await page.reload({ waitUntil: "load" });
  await page.click("#tab-2");
  const after = await page.evaluate(() => ({
    checked: document.querySelector('input[data-mark="2.2"]').checked,
    ring: document.querySelector('#tab-2 .tl-count').textContent,
    dash: document.querySelector('#tab-2 .tl-fill').getAttribute("stroke-dasharray"),
    stored: (() => { try { return Object.keys(JSON.parse(localStorage.getItem("spectroscope:localSetup"))); } catch (e) { return String(e); } })(),
  }));
  check("the mark is still set after a reload and the ring shows one of four",
    after.checked && after.ring === "1 of 4" && after.dash === "25 100", after);
  await page.screenshot({ path: join(OUT_DIR, `${LABEL}-marked-level2.png`), fullPage: false });
  await ctx.close();
}

// 3. storage blocked: the page renders and the mark works for the session
{
  const { ctx, page } = await open(1280, { blockStorage: true });
  await page.click("#tab-2");
  await page.check('input[data-mark="2.1"]');
  const s = await page.evaluate(() => ({
    ring: document.querySelector('#tab-2 .tl-count').textContent,
    cards: document.querySelectorAll(".card").length,
    progress: document.getElementById("progress").textContent,
  }));
  check("with storage blocked the page renders and the mark counts", s.ring === "1 of 4" && s.cards > 20, s);
  await ctx.close();
}

// 4. the download links resolve in the served layout
{
  const { ctx, page } = await open(1280);
  const hrefs = await page.evaluate(() => [...document.querySelectorAll("a.dl")].map((a) => a.getAttribute("href")));
  const missing = [];
  for (const h of hrefs) {
    try { readFileSync(join(SCRIPTS_DIR, h.replace(/^scripts\//, ""))); } catch (e) { missing.push(h); }
  }
  check("every script link names a file in the scripts folder", hrefs.length > 0 && missing.length === 0, { links: hrefs.length, missing });
  await ctx.close();
}

// 5. contrast: every text node in all four designs, every level, both
//    platforms, the sources open. WCAG ratio of the text colour (alpha
//    composited) on the first opaque background up the tree; 4.5:1, or 3:1
//    for large text (24px, or 18.66px bold).
{
  const { ctx, page } = await open(1280);
  const worst = {};
  for (const design of ["spectroscope", "paper", "still", "graphite"]) {
    const reached = await toDesign(page, design);
    check(`design switch reaches ${design} for the contrast pass`, reached);
    await page.evaluate(() => { const d = document.querySelector(".foot details"); if (d) d.open = true; });
    const fails = [];
    let nodes = 0;
    let min = Infinity;
    for (const platform of ["mac", "linux"]) {
      await page.click(`[data-set-platform="${platform}"]`);
      for (let level = 1; level <= 7; level++) {
        await page.click(`#tab-${level}`);
        await page.waitForTimeout(50);
        const r = await page.evaluate(() => {
          function parse(c) {
            let m = c.match(/^rgba?\(([^)]+)\)$/);
            if (m) {
              const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
              return [v[0] / 255, v[1] / 255, v[2] / 255, v.length > 3 ? v[3] : 1];
            }
            m = c.match(/^color\(srgb ([^)]+)\)$/);
            if (m) {
              const v = m[1].split(/[ /]+/).filter(Boolean).map(Number);
              return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1];
            }
            throw new Error("unparsed colour " + c);
          }
          const lin = (u) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
          const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
          const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat([1]);
          function background(el) {
            const layers = [];
            for (let e = el; e; e = e.parentElement) {
              const b = parse(getComputedStyle(e).backgroundColor);
              if (b[3] > 0) layers.push(b);
              if (b[3] >= 1) break;
            }
            let bg = [1, 1, 1, 1];
            for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
            return bg;
          }
          const out = { nodes: 0, min: Infinity, fails: [] };
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent.trim()) continue;
            const el = n.parentElement;
            if (!el || el.closest("script, style")) continue;
            const rects = el.getClientRects();
            if (!rects.length || el.offsetParent === null && getComputedStyle(el).position !== "fixed") continue;
            const st = getComputedStyle(el);
            if (st.visibility === "hidden") continue;
            const bg = background(el);
            const fg = over(parse(st.color), bg);
            const a = lum(fg), b = lum(bg);
            const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            const size = parseFloat(st.fontSize);
            const large = size >= 24 || (size >= 18.66 && Number(st.fontWeight) >= 700);
            const need = large ? 3 : 4.5;
            out.nodes++;
            out.min = Math.min(out.min, ratio);
            if (ratio < need) {
              out.fails.push({ text: n.textContent.trim().slice(0, 40), cls: el.className, color: st.color, ratio: Math.round(ratio * 100) / 100 });
            }
          }
          return out;
        });
        nodes += r.nodes;
        min = Math.min(min, r.min);
        for (const f of r.fails) if (fails.length < 25) fails.push({ level, platform, ...f });
      }
    }
    worst[design] = { nodes, min: Math.round(min * 100) / 100, fails: fails.length };
    check(`text contrast at 4.5:1 or more in ${design}`, fails.length === 0 && nodes > 500, { nodes, min, fails });
  }
  result.contrast = worst;
  await ctx.close();
}

await browser.close();
check("console errors", result.consoleErrors.length === 0, result.consoleErrors);
check("no request beyond the page", result.foreignRequests.length === 0, result.foreignRequests);
writeFileSync(join(OUT_DIR, `${LABEL}-result.json`), JSON.stringify(result, null, 2));
for (const c of result.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}`);
process.exit(failed ? 1 : 0);
